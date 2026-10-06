import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";

/**
 * Daily readiness score from HRV, resting HR, sleep, training load (ACWR) and
 * how the user feels. Personal baselines, not population norms.
 * `days` accepts the `data.days` array from /wearables-normalize as-is.
 */

const DayIn = z.object({
  date: z.string(),
  hrv_rmssd_ms: z.number().positive().optional(),
  resting_hr_bpm: z.number().positive().optional(),
  sleep: z.object({ total_min: z.number().optional(), efficiency_pct: z.number().optional() }).partial().loose().optional(),
  training_load: z.number().min(0).optional().describe("Any consistent unit, e.g. session RPE x minutes, TRIMP or WHOOP strain."),
  soreness_1_5: z.number().min(1).max(5).optional(),
  stress_1_5: z.number().min(1).max(5).optional(),
  mood_1_5: z.number().min(1).max(5).optional(),
}).loose();

const Weights = z.object({
  hrv: z.number().min(0).default(0.35),
  resting_hr: z.number().min(0).default(0.2),
  sleep: z.number().min(0).default(0.25),
  load: z.number().min(0).default(0.1),
  subjective: z.number().min(0).default(0.1),
});

const Input = z.object({
  days: z.array(DayIn).min(1).max(120).describe("Oldest → newest. The last entry is scored. 14-30 days of history gives the best baselines."),
  sleep_need_min: z.number().min(240).max(720).default(480),
  weights: Weights.default(Weights.parse({})),
});

const Component = z.object({
  score: z.number().optional(),
  status: z.enum(["ok", "insufficient_data"]),
  detail: z.string(),
});

const Output = z.object({
  date: z.string(),
  score: z.number(),
  band: z.enum(["prime", "ready", "moderate", "recover"]),
  components: z.object({
    hrv: Component.extend({ today_ms: z.number().optional(), baseline_ms: z.number().optional(), z_score: z.number().optional() }),
    resting_hr: Component.extend({ today_bpm: z.number().optional(), baseline_bpm: z.number().optional(), delta_bpm: z.number().optional() }),
    sleep: Component.extend({ total_min: z.number().optional(), need_min: z.number(), efficiency_pct: z.number().optional() }),
    load: Component.extend({ acute: z.number().optional(), chronic: z.number().optional(), acwr: z.number().optional(), zone: z.enum(["low", "optimal", "elevated", "high_risk"]).optional() }),
    subjective: Component,
  }),
  recommendation: z.object({ training: z.string(), max_rpe: z.number(), focus: z.array(z.string()) }),
  flags: z.array(z.object({ code: z.string(), message: z.string() })),
});

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const r = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;

const MIN_BASELINE_DAYS = 5;

export default defineEndpoint({
  slug: "recovery-readiness",
  title: "Recovery & Readiness Score",
  summary: "0-100 readiness score with explainable components (HRV, resting HR, sleep, ACWR training load, subjective) and a training recommendation.",
  category: "wearables",
  usesAI: false,
  zeePalmServices: ["Wearable Integrations", "Coaching Platform Setup", "Gym Platform Setup", "AI Coach Assistant"],
  input: Input,
  output: Output,
  disclaimer: "Wellness guidance only. Not a medical device and not for diagnosing illness.",
  exampleInput: {
    days: [
      ...Array.from({ length: 20 }, (_, i) => ({
        date: `2026-09-${String(i + 11).padStart(2, "0")}`,
        hrv_rmssd_ms: 58 + ((i * 7) % 9) - 4,
        resting_hr_bpm: 52 + (i % 3),
        sleep: { total_min: 440 + ((i * 13) % 60), efficiency_pct: 89 },
        training_load: [420, 0, 510, 380, 0, 600, 300][i % 7],
      })),
      { date: "2026-10-01", hrv_rmssd_ms: 47, resting_hr_bpm: 57, sleep: { total_min: 372, efficiency_pct: 84 }, training_load: 650, soreness_1_5: 4, stress_1_5: 3, mood_1_5: 3 },
    ],
    sleep_need_min: 480,
  },
  run({ days, sleep_need_min, weights }) {
    const today = days[days.length - 1];
    const prior = days.slice(0, -1).slice(-30);
    const flags: { code: string; message: string }[] = [];

    // HRV: ln(rMSSD) vs personal baseline; ±0.5 SD is normal day-to-day noise.
    const hrvBase = prior.map((d) => d.hrv_rmssd_ms).filter((v): v is number => v !== undefined);
    let hrv: z.infer<typeof Output>["components"]["hrv"];
    if (today.hrv_rmssd_ms && hrvBase.length >= MIN_BASELINE_DAYS) {
      const lns = hrvBase.map(Math.log);
      const zScore = (Math.log(today.hrv_rmssd_ms) - mean(lns)) / Math.max(sd(lns), 0.05);
      hrv = {
        score: r(clamp(70 + 25 * zScore), 0),
        status: "ok",
        today_ms: today.hrv_rmssd_ms,
        baseline_ms: r(Math.exp(mean(lns))),
        z_score: r(zScore, 2),
        detail: Math.abs(zScore) <= 0.5 ? "HRV within your normal range." : zScore > 0 ? "HRV above your normal range." : "HRV below your normal range.",
      };
      if (zScore < -1.5) flags.push({ code: "hrv_suppressed", message: "HRV is well below your baseline. Prioritise recovery." });
    } else {
      hrv = { status: "insufficient_data", detail: `Needs today's HRV and ${MIN_BASELINE_DAYS}+ prior days.` };
    }

    // Resting HR: each bpm above baseline costs points.
    const rhrBase = prior.map((d) => d.resting_hr_bpm).filter((v): v is number => v !== undefined);
    let rhr: z.infer<typeof Output>["components"]["resting_hr"];
    if (today.resting_hr_bpm && rhrBase.length >= MIN_BASELINE_DAYS) {
      const delta = today.resting_hr_bpm - mean(rhrBase);
      rhr = {
        score: r(clamp(75 - 7 * delta), 0),
        status: "ok",
        today_bpm: today.resting_hr_bpm,
        baseline_bpm: r(mean(rhrBase)),
        delta_bpm: r(delta),
        detail: delta >= 3 ? `Resting HR is ${r(delta)} bpm above baseline.` : "Resting HR normal.",
      };
      if (delta >= 7) flags.push({ code: "rhr_elevated", message: "Resting HR is 7+ bpm above baseline, often a sign of illness, stress or under-recovery." });
    } else {
      rhr = { status: "insufficient_data", detail: `Needs today's resting HR and ${MIN_BASELINE_DAYS}+ prior days.` };
    }
    if ((hrv.z_score ?? 0) < -1 && (rhr.delta_bpm ?? 0) >= 5) {
      flags.push({ code: "illness_watch", message: "Low HRV together with high resting HR. Watch for illness symptoms." });
    }

    // Sleep: 80% duration vs need, 20% efficiency.
    const total = today.sleep?.total_min;
    const eff = today.sleep?.efficiency_pct;
    let sleep: z.infer<typeof Output>["components"]["sleep"];
    if (total !== undefined) {
      const durScore = clamp((total / sleep_need_min) * 100);
      const effScore = eff === undefined ? durScore : clamp(((eff - 70) / 25) * 100);
      sleep = {
        score: r(0.8 * durScore + 0.2 * effScore, 0),
        status: "ok",
        total_min: total,
        need_min: sleep_need_min,
        efficiency_pct: eff,
        detail: total >= sleep_need_min ? "Sleep need met." : `${Math.round(sleep_need_min - total)} min short of sleep need.`,
      };
      if (total < 360) flags.push({ code: "short_sleep", message: "Under 6 hours of sleep. Reaction time and injury risk are affected." });
    } else {
      sleep = { status: "insufficient_data", need_min: sleep_need_min, detail: "No sleep duration for today." };
    }

    // Load: acute (7-day) vs chronic (28-day) daily average.
    const loads = days.slice(-28).map((d) => d.training_load);
    const known = loads.filter((v): v is number => v !== undefined);
    let load: z.infer<typeof Output>["components"]["load"];
    if (known.length >= 14) {
      const acute = mean(loads.slice(-7).map((v) => v ?? 0));
      const chronic = mean(loads.map((v) => v ?? 0));
      const acwr = chronic > 0 ? acute / chronic : 0;
      const zone = acwr < 0.8 ? "low" : acwr <= 1.3 ? "optimal" : acwr <= 1.5 ? "elevated" : "high_risk";
      load = {
        score: { low: 80, optimal: 90, elevated: 60, high_risk: 30 }[zone],
        status: "ok",
        acute: r(acute),
        chronic: r(chronic),
        acwr: r(acwr, 2),
        zone,
        detail: `Acute:chronic workload ratio ${r(acwr, 2)} (${zone.replace("_", " ")}).`,
      };
      if (zone === "high_risk") flags.push({ code: "load_spike", message: "Training load spiked over 1.5x your 4-week average. Injury risk is higher." });
    } else {
      load = { status: "insufficient_data", detail: "Needs training_load on 14+ of the last 28 days." };
    }

    // Subjective: soreness and stress are inverted, mood is direct.
    const subj = [today.soreness_1_5 && 6 - today.soreness_1_5, today.stress_1_5 && 6 - today.stress_1_5, today.mood_1_5].filter((v): v is number => typeof v === "number");
    const subjective = subj.length
      ? { score: r(((mean(subj) - 1) / 4) * 100, 0), status: "ok" as const, detail: `Based on ${subj.length} self-reported rating(s).` }
      : { status: "insufficient_data" as const, detail: "No soreness / stress / mood ratings." };

    const parts: [number | undefined, number][] = [
      [hrv.score, weights.hrv],
      [rhr.score, weights.resting_hr],
      [sleep.score, weights.sleep],
      [load.score, weights.load],
      [subjective.score, weights.subjective],
    ];
    const used = parts.filter(([s, w]) => s !== undefined && w > 0) as [number, number][];
    const wsum = used.reduce((a, [, w]) => a + w, 0);
    const score = wsum ? Math.round(used.reduce((a, [s, w]) => a + s * w, 0) / wsum) : 50;
    if (!used.length) flags.push({ code: "no_data", message: "Not enough data to score. Returned a neutral 50." });

    const band: z.infer<typeof Output>["band"] = score >= 80 ? "prime" : score >= 65 ? "ready" : score >= 50 ? "moderate" : "recover";
    const rec = {
      prime: { training: "Green light for a hard session or a PR attempt.", max_rpe: 9, focus: ["high intensity", "strength / power"] },
      ready: { training: "Train as planned.", max_rpe: 8, focus: ["planned session"] },
      moderate: { training: "Keep it moderate: technique, zone 2 or reduced volume.", max_rpe: 6, focus: ["zone 2 cardio", "technique", "mobility"] },
      recover: { training: "Recovery day: walk, mobility, sleep and hydration.", max_rpe: 4, focus: ["rest", "mobility", "sleep"] },
    }[band];

    return { date: today.date, score, band, components: { hrv, resting_hr: rhr, sleep, load, subjective }, recommendation: rec, flags };
  },
});
