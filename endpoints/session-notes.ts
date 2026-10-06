import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";
import { crisisResources, detectRedFlags } from "@/lib/safety";

/**
 * Session transcript or rough notes → structured clinical/coaching note
 * (SOAP, DAP, BIRP or GROW), action items, metrics, follow-up and a
 * plain-language recap the client can receive.
 */

const FORMATS = {
  soap: [["S", "Subjective"], ["O", "Objective"], ["A", "Assessment"], ["P", "Plan"]],
  dap: [["D", "Data"], ["A", "Assessment"], ["P", "Plan"]],
  birp: [["B", "Behaviour"], ["I", "Intervention"], ["R", "Response"], ["P", "Plan"]],
  grow: [["G", "Goal"], ["R", "Reality"], ["O", "Options"], ["W", "Way forward"]],
} as const;

const Input = z.object({
  transcript: z.string().min(20).max(60_000).describe("Raw transcript (speech-to-text) or the practitioner's rough notes."),
  format: z.enum(["soap", "dap", "birp", "grow"]).default("soap"),
  practitioner_type: z.enum(["physiotherapist", "therapist", "counsellor", "psychologist", "dietitian", "personal_trainer", "health_coach", "gp", "nurse"]),
  client_context: z.string().max(4000).optional().describe("Goals, history or last session's plan."),
  recap_for_client: z.boolean().default(true),
});

const AIOut = z.object({
  sections: z.array(z.object({ key: z.string(), title: z.string(), content: z.string() })),
  key_metrics: z.array(z.object({ name: z.string(), value: z.string(), unit: z.string().optional() })).describe("Measurements mentioned: pain 0-10, ROM, weight, PHQ-9..."),
  action_items: z.array(z.object({ owner: z.enum(["client", "practitioner"]), task: z.string(), due: z.string().optional() })),
  follow_up: z.object({ recommended_in_days: z.number().optional(), reason: z.string() }),
  client_recap: z.string().optional().describe("Warm, plain-language recap for the client. No jargon, no diagnosis."),
  risk_notes: z.array(z.string()).describe("Any risk the practitioner should review (self-harm, red-flag symptoms, safeguarding)."),
  missing_documentation: z.array(z.string()).describe("Things a complete note would usually include but the transcript lacks."),
});

const Output = AIOut.extend({
  format: z.enum(["soap", "dap", "birp", "grow"]),
  safety: z.object({
    flags: z.array(z.object({ category: z.string(), label: z.string(), matched: z.string() })),
    resources: z.array(z.object({ region: z.string(), name: z.string(), contact: z.string() })),
  }),
});

export default defineEndpoint({
  slug: "session-notes",
  title: "AI Session Notes (SOAP / DAP / BIRP / GROW)",
  summary: "Turn a session transcript into a structured clinical or coaching note with metrics, action items, follow-up and a client-friendly recap.",
  category: "ai",
  usesAI: true,
  zeePalmServices: ["AI Agent (Coaches)", "Healthcare / Mental-Health Prototype", "Coaching Platform Setup", "AI Coach Assistant", "Custom GPT / Brand Assistant"],
  input: Input,
  output: Output,
  disclaimer: "Draft documentation. The practitioner must review and sign off. Don't send identifiable health data to an AI provider without a BAA/DPA in place.",
  exampleInput: {
    format: "soap",
    practitioner_type: "physiotherapist",
    client_context: "Week 6 after right ACL reconstruction. Goal: return to 5-a-side football.",
    transcript:
      "Physio: How's the knee this week? Client: Better, pain is about 2 out of 10 on stairs, 0 at rest. Did my exercises most days, missed Sunday. " +
      "Physio: Let's measure. Flexion is 125 degrees, extension full, zero. Single-leg squat still shows some valgus on the right. Quads look stronger. " +
      "Physio: We'll add step-downs and start the bike with resistance. Keep icing after sessions. Client: Can I start jogging? Physio: Not yet, let's reassess in two weeks.",
    recap_for_client: true,
  },
  async run(input, { ai }) {
    const sections = FORMATS[input.format];
    const flags = detectRedFlags(input.transcript);
    const out = await ai.generate({
      system: `You are a clinical documentation assistant for a ${input.practitioner_type.replace("_", " ")}.
Write a ${input.format.toUpperCase()} note with exactly these sections in order: ${sections.map(([k, t]) => `${k} = ${t}`).join(", ")}.
- Use only facts stated in the transcript or context. Never invent measurements, diagnoses or medications.
- Write concise professional notes (bullets inside content are fine, use "- ").
- Quote the client's own words for subjective statements where useful.
- Put anything that suggests risk (self-harm, red-flag symptoms, safeguarding) in risk_notes.
${input.recap_for_client ? "- Write client_recap in second person, under 120 words." : "- Omit client_recap."}`,
      prompt: `<input>\n${JSON.stringify({ client_context: input.client_context, transcript: input.transcript })}\n</input>`,
      schema: AIOut,
    });
    return {
      ...out,
      format: input.format,
      risk_notes: [...out.risk_notes, ...flags.filter((f) => !out.risk_notes.some((n) => n.includes(f.matched))).map((f) => `Safety rule matched "${f.matched}" (${f.label}). Review.`)],
      safety: { flags, resources: flags.length ? crisisResources() : [] },
    };
  },
  exampleOutput: {
    sections: [
      { key: "S", title: "Subjective", content: "- Pain 2/10 on stairs, 0/10 at rest.\n- Adherent to HEP most days (missed 1 day).\n- Asking about return to jogging." },
      { key: "O", title: "Objective", content: "- R knee flexion 125°, extension 0° (full).\n- Single-leg squat: residual R dynamic valgus.\n- Quadriceps strength visibly improved." },
      { key: "A", title: "Assessment", content: "Week 6 post R ACLR, progressing as expected. ROM near full; neuromuscular control of valgus still limited, so not yet ready for running." },
      { key: "P", title: "Plan", content: "- Add step-downs (3x10).\n- Start stationary bike with resistance.\n- Continue ice after sessions.\n- Reassess for return-to-run criteria in 2 weeks." },
    ],
    key_metrics: [
      { name: "Pain on stairs", value: "2", unit: "/10" },
      { name: "Knee flexion (R)", value: "125", unit: "degrees" },
      { name: "Knee extension (R)", value: "0", unit: "degrees" },
    ],
    action_items: [
      { owner: "client", task: "Step-downs 3x10 daily" },
      { owner: "client", task: "Stationary bike with resistance, 15-20 min" },
      { owner: "practitioner", task: "Return-to-run criteria assessment", due: "in 2 weeks" },
    ],
    follow_up: { recommended_in_days: 14, reason: "Reassess for return-to-run criteria" },
    client_recap:
      "Great progress this week! Your knee bends to 125° and straightens fully. Keep doing your exercises and add the step-downs and the bike with some resistance. Ice after sessions. We'll check in 2 weeks whether you're ready to start jogging.",
    risk_notes: [],
    missing_documentation: ["Swelling / effusion grade", "Quadriceps strength measurement (e.g. dynamometer)"],
  },
});
