import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";
import { ApiError } from "@/lib/errors";
import { crisisResources, detectRedFlags } from "@/lib/safety";

/**
 * Scores validated, free-to-use screening questionnaires with published cut-offs,
 * change tracking and a hard safety rule on self-harm items.
 * Add an instrument: add an entry to INSTRUMENTS.
 */

interface Instrument {
  name: string;
  items: number;
  min: number;
  max: number;
  /** [upper bound inclusive, label] sorted ascending */
  bands: [number, string][];
  positiveAt?: number;
  /** Points of change considered clinically meaningful. */
  reliableChange: number;
  higherIsWorse: boolean;
  /** Item index (0-based) that screens for self-harm. */
  selfHarmItem?: number;
  transform?: (total: number) => number;
  itemText: string[];
}

const PHQ9_ITEMS = [
  "Little interest or pleasure in doing things",
  "Feeling down, depressed, or hopeless",
  "Trouble falling or staying asleep, or sleeping too much",
  "Feeling tired or having little energy",
  "Poor appetite or overeating",
  "Feeling bad about yourself, or that you are a failure",
  "Trouble concentrating on things",
  "Moving or speaking slowly, or being fidgety or restless",
  "Thoughts that you would be better off dead, or of hurting yourself",
];
const GAD7_ITEMS = [
  "Feeling nervous, anxious, or on edge",
  "Not being able to stop or control worrying",
  "Worrying too much about different things",
  "Trouble relaxing",
  "Being so restless that it's hard to sit still",
  "Becoming easily annoyed or irritable",
  "Feeling afraid as if something awful might happen",
];
const WHO5_ITEMS = [
  "I have felt cheerful and in good spirits",
  "I have felt calm and relaxed",
  "I have felt active and vigorous",
  "I woke up feeling fresh and rested",
  "My daily life has been filled with things that interest me",
];

const INSTRUMENTS: Record<string, Instrument> = {
  phq9: {
    name: "PHQ-9 (depression)", items: 9, min: 0, max: 3, reliableChange: 5, higherIsWorse: true, selfHarmItem: 8, positiveAt: 10,
    bands: [[4, "minimal"], [9, "mild"], [14, "moderate"], [19, "moderately_severe"], [27, "severe"]], itemText: PHQ9_ITEMS,
  },
  phq2: { name: "PHQ-2 (depression pre-screen)", items: 2, min: 0, max: 3, reliableChange: 2, higherIsWorse: true, positiveAt: 3, bands: [[2, "negative"], [6, "positive"]], itemText: PHQ9_ITEMS.slice(0, 2) },
  gad7: { name: "GAD-7 (anxiety)", items: 7, min: 0, max: 3, reliableChange: 4, higherIsWorse: true, positiveAt: 10, bands: [[4, "minimal"], [9, "mild"], [14, "moderate"], [21, "severe"]], itemText: GAD7_ITEMS },
  gad2: { name: "GAD-2 (anxiety pre-screen)", items: 2, min: 0, max: 3, reliableChange: 2, higherIsWorse: true, positiveAt: 3, bands: [[2, "negative"], [6, "positive"]], itemText: GAD7_ITEMS.slice(0, 2) },
  who5: {
    name: "WHO-5 (wellbeing)", items: 5, min: 0, max: 5, reliableChange: 10, higherIsWorse: false,
    transform: (t) => t * 4, bands: [[28, "likely_depression"], [50, "poor_wellbeing"], [100, "good_wellbeing"]], itemText: WHO5_ITEMS,
  },
};

const NEXT_STEPS: Record<string, string[]> = {
  minimal: ["No action needed. Rescreen in 4-12 weeks or if things change."],
  negative: ["No action needed. Rescreen periodically."],
  good_wellbeing: ["No action needed. Keep doing what's working."],
  mild: ["Watchful waiting; offer self-help resources and rescreen in 2-4 weeks."],
  positive: ["Pre-screen positive: complete the full PHQ-9 / GAD-7."],
  poor_wellbeing: ["Wellbeing is low: follow up with the PHQ-9 and offer support resources."],
  moderate: ["Recommend a review with a qualified clinician to discuss treatment options."],
  moderately_severe: ["Recommend prompt clinical review; therapy and/or medication are usually discussed."],
  severe: ["Recommend urgent clinical review."],
  likely_depression: ["Score suggests depression: follow up with the PHQ-9 and a clinician."],
};

const Input = z.object({
  instrument: z.enum(Object.keys(INSTRUMENTS) as [string, ...string[]]),
  responses: z.array(z.number().int()).describe("One integer per item, in order. PHQ/GAD: 0-3. WHO-5: 0-5."),
  free_text: z.string().max(5000).optional().describe("Optional journal entry / comment. Scanned for crisis language."),
  previous: z.object({ score: z.number(), date: z.string().optional() }).optional().describe("Last score on the same instrument, for change tracking."),
});

const Output = z.object({
  instrument: z.string(),
  instrument_name: z.string(),
  score: z.number(),
  max_score: z.number(),
  severity: z.string(),
  screen_positive: z.boolean(),
  item_breakdown: z.array(z.object({ item: z.number(), text: z.string(), value: z.number() })),
  change: z
    .object({ previous: z.number(), delta: z.number(), direction: z.enum(["improved", "worsened", "no_reliable_change"]), reliable: z.boolean() })
    .optional(),
  safety: z.object({
    risk: z.enum(["none", "review", "urgent"]),
    reasons: z.array(z.string()),
    resources: z.array(z.object({ region: z.string(), name: z.string(), contact: z.string() })),
  }),
  next_steps: z.array(z.string()),
  clinician_review_recommended: z.boolean(),
});

export default defineEndpoint({
  slug: "mental-health-screening",
  title: "Mental Health Screening Scorer",
  summary: "Score PHQ-9, PHQ-2, GAD-7, GAD-2 and WHO-5 with severity bands, change tracking and self-harm safety escalation.",
  category: "mental-health",
  usesAI: false,
  zeePalmServices: ["Healthcare / Mental-Health Prototype", "Healthtech & Mental Health MVP Blueprint", "Healthtech / Mental-Health Intended-Use & Dependency Map"],
  input: Input,
  output: Output,
  disclaimer: "Screening tool, not a diagnosis. Results should be reviewed by a qualified professional. Not for emergencies.",
  exampleInput: { instrument: "phq9", responses: [2, 2, 3, 2, 1, 2, 1, 0, 0], previous: { score: 9, date: "2026-09-08" } },
  run({ instrument, responses, free_text, previous }) {
    const inst = INSTRUMENTS[instrument];
    if (responses.length !== inst.items) throw new ApiError(422, "validation_error", `${inst.name} needs exactly ${inst.items} responses, got ${responses.length}.`);
    const bad = responses.findIndex((v) => v < inst.min || v > inst.max);
    if (bad >= 0) throw new ApiError(422, "validation_error", `Response ${bad + 1} must be between ${inst.min} and ${inst.max}.`);

    const raw = responses.reduce((a, b) => a + b, 0);
    const score = inst.transform ? inst.transform(raw) : raw;
    const max = inst.transform ? inst.transform(inst.items * inst.max) : inst.items * inst.max;
    const severity = inst.bands.find(([upper]) => score <= upper)![1];
    const positive = inst.positiveAt !== undefined ? score >= inst.positiveAt : ["likely_depression", "poor_wellbeing"].includes(severity);

    const reasons: string[] = [];
    let risk: "none" | "review" | "urgent" = "none";
    if (inst.selfHarmItem !== undefined && responses[inst.selfHarmItem] > 0) {
      risk = "urgent";
      reasons.push(`Item ${inst.selfHarmItem + 1} (thoughts of self-harm) answered ${responses[inst.selfHarmItem]}. Same-day safety assessment required.`);
    }
    for (const flag of free_text ? detectRedFlags(free_text) : []) {
      if (flag.category === "self_harm" || flag.category === "harm_to_others" || flag.category === "overdose") {
        risk = "urgent";
        reasons.push(`Free text mentions: "${flag.matched}" (${flag.label}).`);
      }
    }
    if (risk === "none" && ["moderately_severe", "severe", "likely_depression"].includes(severity)) {
      risk = "review";
      reasons.push(`Score is in the ${severity.replace("_", " ")} range.`);
    }

    let change: z.infer<typeof Output>["change"];
    if (previous) {
      const delta = score - previous.score;
      const reliable = Math.abs(delta) >= inst.reliableChange;
      const better = inst.higherIsWorse ? delta < 0 : delta > 0;
      change = { previous: previous.score, delta, reliable, direction: !reliable ? "no_reliable_change" : better ? "improved" : "worsened" };
    }

    const nextSteps = [...(NEXT_STEPS[severity] ?? [])];
    if (risk === "urgent") nextSteps.unshift("Contact the person today for a safety check. Share crisis resources now.");

    return {
      instrument,
      instrument_name: inst.name,
      score,
      max_score: max,
      severity,
      screen_positive: positive,
      item_breakdown: responses.map((v, i) => ({ item: i + 1, text: inst.itemText[i], value: v })),
      change,
      safety: { risk, reasons, resources: risk === "none" ? [] : crisisResources() },
      next_steps: nextSteps,
      clinician_review_recommended: risk !== "none" || positive,
    };
  },
});
