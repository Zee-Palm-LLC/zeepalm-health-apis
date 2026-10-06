import { describe, expect, it } from "vitest";
import { call } from "./helpers";
import { detectRedFlags } from "@/lib/safety";
import { toStrictAllRequired } from "@/lib/json-schema";

describe("nutrition-targets", () => {
  it("matches Mifflin-St Jeor and converts imperial units", async () => {
    const { body } = await call("nutrition-targets", { sex: "male", age: 30, height_in: 70.866, weight_lb: 176.37, goal: "maintain", activity_level: "sedentary" });
    // 10*80 + 6.25*180 - 5*30 + 5 = 1780
    expect(body.data.bmr.kcal).toBeCloseTo(1780, -1);
    expect(body.data.tdee_kcal).toBe(2140);
  });
  it("never sets a deficit below the safe floor", async () => {
    const { body } = await call("nutrition-targets", { sex: "female", age: 40, height_cm: 155, weight_kg: 52, goal: "lose", rate_pct_bodyweight_per_week: 1.5, activity_level: "sedentary" });
    expect(body.data.target_kcal).toBeGreaterThanOrEqual(1200);
    expect(body.data.warnings.length).toBeGreaterThan(0);
  });
});

describe("mental-health-screening", () => {
  it("escalates PHQ-9 item 9 regardless of total", async () => {
    const { body } = await call("mental-health-screening", { instrument: "phq9", responses: [0, 0, 0, 0, 0, 0, 0, 0, 1] });
    expect(body.data.severity).toBe("minimal");
    expect(body.data.safety.risk).toBe("urgent");
    expect(body.data.safety.resources.length).toBeGreaterThan(0);
  });
  it("scores WHO-5 as a percentage and tracks reliable change", async () => {
    const { body } = await call("mental-health-screening", { instrument: "who5", responses: [1, 1, 2, 1, 1], previous: { score: 60 } });
    expect(body.data.score).toBe(24);
    expect(body.data.severity).toBe("likely_depression");
    expect(body.data.change.direction).toBe("worsened");
  });
  it("rejects the wrong number of answers", async () => {
    expect((await call("mental-health-screening", { instrument: "gad7", responses: [1, 2] })).status).toBe(422);
  });
});

describe("wearables-normalize", () => {
  it("maps WHOOP payloads", async () => {
    const { body } = await call("wearables-normalize", {
      source: "whoop",
      timezone: "UTC",
      data: {
        recovery: { records: [{ created_at: "2026-10-05T07:00:00Z", score: { recovery_score: 71, resting_heart_rate: 50, hrv_rmssd_milli: 64.2 } }] },
        sleep: { records: [{ end: "2026-10-05T06:30:00Z", nap: false, score: { stage_summary: { total_light_sleep_time_milli: 13_800_000, total_slow_wave_sleep_time_milli: 5_400_000, total_rem_sleep_time_milli: 6_000_000, total_awake_time_milli: 1_800_000 } } }] },
      },
    });
    const day = body.data.days[0];
    expect(day).toMatchObject({ date: "2026-10-05", hrv_rmssd_ms: 64.2, resting_hr_bpm: 50, vendor_scores: { whoop_recovery: 71 } });
    expect(day.sleep.total_min).toBe(420);
  });
  it("aggregates Apple Health samples by local day", async () => {
    const { body } = await call("wearables-normalize", {
      source: "apple_health",
      timezone: "Asia/Karachi",
      data: [
        { type: "HKQuantityTypeIdentifierStepCount", value: 4000, startDate: "2026-10-04T20:00:00Z", endDate: "2026-10-04T20:30:00Z" },
        { type: "HKQuantityTypeIdentifierStepCount", value: 1000, startDate: "2026-10-05T03:00:00Z", endDate: "2026-10-05T03:10:00Z" },
      ],
    });
    // 20:00Z = 01:00 on the 5th in Karachi (UTC+5)
    expect(body.data.days).toEqual([expect.objectContaining({ date: "2026-10-05", steps: 5000 })]);
  });
});

describe("recovery-readiness", () => {
  it("drops the score when HRV crashes and RHR rises", async () => {
    const base = Array.from({ length: 14 }, (_, i) => ({ date: `2026-09-${10 + i}`, hrv_rmssd_ms: 60 + (i % 3), resting_hr_bpm: 50 + (i % 2), sleep: { total_min: 480 } }));
    const good = await call("recovery-readiness", { days: [...base, { date: "2026-09-24", hrv_rmssd_ms: 61, resting_hr_bpm: 50, sleep: { total_min: 480 } }] });
    const bad = await call("recovery-readiness", { days: [...base, { date: "2026-09-24", hrv_rmssd_ms: 38, resting_hr_bpm: 59, sleep: { total_min: 330 } }] });
    expect(good.body.data.score).toBeGreaterThan(bad.body.data.score);
    expect(bad.body.data.band).toBe("recover");
    expect(bad.body.data.flags.map((f: { code: string }) => f.code)).toEqual(expect.arrayContaining(["hrv_suppressed", "rhr_elevated", "illness_watch", "short_sleep"]));
  });
});

describe("member-churn-risk", () => {
  it("ranks the disengaging member above the engaged one", async () => {
    const { body } = await call("member-churn-risk", {
      members: [
        { id: "engaged", joined_at: "2024-01-01", last_visit_at: "2026-10-05", visits_last_30d: 12, visits_prev_30d: 12, nps: 10 },
        { id: "slipping", joined_at: "2026-08-01", last_visit_at: "2026-09-10", visits_last_30d: 1, visits_prev_30d: 10, payment_failures_90d: 1, monthly_value: 50 },
      ],
      options: { now: "2026-10-06T00:00:00Z" },
    });
    expect(body.data.members[0].id).toBe("slipping");
    expect(body.data.members[0].risk_band).toBe("critical");
    expect(body.data.members[0].actions.length).toBeGreaterThan(0);
    expect(body.data.members[1].risk_band).toBe("low");
  });
});

describe("front-desk-intake safety net", () => {
  it("forces emergency even when the model says routine", async () => {
    const { body } = await call(
      "front-desk-intake",
      { message: "I have crushing chest pain and my left arm is numb, can I book for tomorrow?", business: { name: "City Clinic", type: "clinic" } },
      { "x-ai-provider": "mock" },
    );
    expect(body.data.urgency).toBe("emergency");
    expect(body.data.handoff.to_human).toBe(true);
    expect(body.meta.safety_guard.escalated).toBe(true);
  });
  it("detects common red flags and ignores benign text", () => {
    expect(detectRedFlags("i don't want to live anymore").map((f) => f.category)).toContain("self_harm");
    expect(detectRedFlags("Can I book a deep tissue massage on Friday?")).toEqual([]);
  });
});

describe("meal-plan allergen guard", () => {
  it("flags allergen ingredients the model slipped in", async () => {
    const { body } = await call(
      "meal-plan",
      { targets: { kcal: 1850, protein_g: 130, carbs_g: 190, fat_g: 62 }, days: 1, allergies: ["dairy", "eggs"] },
      { "x-ai-provider": "mock" },
    );
    expect(body.data.allergen_check.passed).toBe(false);
    expect(body.data.allergen_check.conflicts.map((c: { allergen: string }) => c.allergen)).toEqual(expect.arrayContaining(["dairy", "egg"]));
    expect(body.data.days[0].totals.kcal).toBe(1850);
  });
});

describe("label-scan checks", () => {
  it("flags upper-limit breaches, caffeine and allergens", async () => {
    const { body } = await call("label-scan", { image_url: "https://example.com/label.jpg", allergies: ["soy"], servings_per_day: 2 }, { "x-ai-provider": "mock" });
    const types = body.data.flags.map((f: { type: string }) => f.type);
    expect(types).toEqual(expect.arrayContaining(["upper_limit", "caffeine", "allergen", "proprietary_blend"]));
  });
});

describe("json schema helpers", () => {
  it("makes OpenAI-strict schemas", () => {
    const out = toStrictAllRequired({ type: "object", properties: { a: { type: "string", minLength: 2 }, b: { type: "number" } }, required: ["a"] }) as any;
    expect(out.required).toEqual(["a", "b"]);
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.a.minLength).toBeUndefined();
    expect(out.properties.b.anyOf[1]).toEqual({ type: "null" });
  });
});
