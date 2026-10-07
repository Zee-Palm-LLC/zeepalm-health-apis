import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";

const DEFAULT_WEIGHTS = {
  intercept: -2.2,
  days_since_last_visit: 0.06,
  visit_drop_pct: 0.025,
  low_frequency: 0.9,
  new_member: 0.6,
  no_shows: 0.35,
  payment_failures: 0.8,
  freeze_requests: 0.9,
  open_complaints: 0.6,
  contract_ending_soon: 0.8,
  low_nps: 1.1,
  promoter: -0.8,
  referrals: -0.5,
  app_inactive: 0.5,
};

const Member = z.object({
  id: z.string(),
  name: z.string().optional(),
  joined_at: z.iso.date().or(z.iso.datetime({ offset: true })),
  monthly_value: z.number().min(0).default(0).describe("Monthly revenue from this member, used for revenue-at-risk."),
  contract_end: z.iso.date().optional(),
  last_visit_at: z.iso.date().or(z.iso.datetime({ offset: true })).optional(),
  visits_last_30d: z.number().int().min(0).optional(),
  visits_prev_30d: z.number().int().min(0).optional(),
  visit_dates: z.array(z.string()).optional().describe("Alternative to the counts above: ISO dates of check-ins / sessions."),
  no_shows_30d: z.number().int().min(0).default(0),
  payment_failures_90d: z.number().int().min(0).default(0),
  freeze_requests_90d: z.number().int().min(0).default(0),
  open_complaints: z.number().int().min(0).default(0),
  nps: z.number().int().min(0).max(10).optional(),
  referrals: z.number().int().min(0).default(0),
  last_app_session_at: z.string().optional(),
});

const Input = z.object({
  members: z.array(Member).min(1).max(1000),
  weights: z.object(Object.fromEntries(Object.keys(DEFAULT_WEIGHTS).map((k) => [k, z.number().optional()]))).optional().describe("Override any default weight."),
  thresholds: z.object({ medium: z.number().default(30), high: z.number().default(55), critical: z.number().default(75) }).default({ medium: 30, high: 55, critical: 75 }),
});

const Driver = z.object({ factor: z.string(), impact: z.number(), detail: z.string() });
const Action = z.object({ action: z.string(), channel: z.enum(["sms", "whatsapp", "email", "call", "in_person", "push"]), priority: z.enum(["now", "this_week", "nurture"]) });

const Output = z.object({
  members: z.array(
    z.object({
      id: z.string(),
      name: z.string().optional(),
      risk_score: z.number(),
      risk_band: z.enum(["low", "medium", "high", "critical"]),
      drivers: z.array(Driver),
      actions: z.array(Action),
      signals: z.object({ days_since_last_visit: z.number().optional(), visits_last_30d: z.number().optional(), visit_trend_pct: z.number().optional(), tenure_days: z.number() }),
    }),
  ),
  summary: z.object({
    total: z.number(),
    by_band: z.object({ low: z.number(), medium: z.number(), high: z.number(), critical: z.number() }),
    monthly_revenue_at_risk: z.number().describe("Sum of monthly_value x churn probability."),
    top_drivers: z.array(z.object({ factor: z.string(), members: z.number() })),
  }),
});

const PLAYBOOK: Record<string, z.infer<typeof Action>> = {
  days_since_last_visit: { action: "Personal 'we miss you' message from their coach with a booking link", channel: "whatsapp", priority: "now" },
  visit_drop_pct: { action: "Offer a free goal-review / progress check session", channel: "sms", priority: "this_week" },
  low_frequency: { action: "Suggest a fixed weekly schedule and enrol in a beginner-friendly class", channel: "email", priority: "this_week" },
  new_member: { action: "Run the 90-day onboarding check-in (week 2, 4, 8)", channel: "call", priority: "this_week" },
  no_shows: { action: "Send reminder 2h before sessions; ask if timings still work", channel: "push", priority: "this_week" },
  payment_failures: { action: "Send card-update link and a friendly payment reminder", channel: "email", priority: "now" },
  freeze_requests: { action: "Manager call to understand the reason; offer a downgrade instead of cancel", channel: "call", priority: "now" },
  open_complaints: { action: "Resolve open complaint and follow up personally", channel: "call", priority: "now" },
  contract_ending_soon: { action: "Renewal offer with a progress summary", channel: "email", priority: "this_week" },
  low_nps: { action: "Manager follow-up on their feedback", channel: "call", priority: "now" },
  app_inactive: { action: "Push a personalised workout or challenge in the app", channel: "push", priority: "nurture" },
};

const DAY = 86_400_000;
const daysBetween = (a: Date, b: Date) => Math.floor((a.getTime() - b.getTime()) / DAY);

export default defineEndpoint({
  slug: "member-churn-risk",
  title: "Member Churn Risk",
  summary: "Score up to 1,000 members for churn risk with explainable drivers, retention actions and revenue at risk.",
  category: "retention",
  usesAI: false,
  zeePalmServices: ["Churn Prediction / Recommendations / Forecasting", "Retention Engine", "Member Machine", "CRM Setup", "Email & Retention"],
  input: Input,
  output: Output,
  exampleInput: {
    members: [
      { id: "m_101", name: "Ayesha K.", joined_at: "2026-07-20", monthly_value: 60, last_visit_at: "2026-09-17", visits_last_30d: 2, visits_prev_30d: 11, no_shows_30d: 2, nps: 5 },
      { id: "m_102", name: "Bilal R.", joined_at: "2025-02-01", monthly_value: 45, last_visit_at: "2026-10-04", visits_last_30d: 13, visits_prev_30d: 12, nps: 9, referrals: 2 },
      { id: "m_103", name: "Sara M.", joined_at: "2025-11-11", monthly_value: 80, contract_end: "2026-10-25", last_visit_at: "2026-09-28", visits_last_30d: 5, visits_prev_30d: 7, payment_failures_90d: 1 },
    ],
    options: { now: "2026-10-06T09:00:00Z" },
  },
  run({ members, weights, thresholds }, { now }) {
    const W = { ...DEFAULT_WEIGHTS, ...Object.fromEntries(Object.entries(weights ?? {}).filter(([, v]) => v !== undefined)) } as typeof DEFAULT_WEIGHTS;
    const driverCount = new Map<string, number>();
    let revenueAtRisk = 0;

    const scored = members.map((m) => {
      const tenure = daysBetween(now, new Date(m.joined_at));
      const visits = (m.visit_dates ?? []).map((d) => new Date(d)).filter((d) => !Number.isNaN(d.getTime()));
      const last30 = m.visits_last_30d ?? (visits.length ? visits.filter((d) => daysBetween(now, d) < 30).length : undefined);
      const prev30 = m.visits_prev_30d ?? (visits.length ? visits.filter((d) => { const x = daysBetween(now, d); return x >= 30 && x < 60; }).length : undefined);
      const lastVisit = m.last_visit_at ? new Date(m.last_visit_at) : visits.length ? new Date(Math.max(...visits.map((d) => d.getTime()))) : undefined;
      const sinceVisit = lastVisit ? daysBetween(now, lastVisit) : undefined;
      const trend = last30 !== undefined && prev30 ? Math.round(((last30 - prev30) / prev30) * 100) : undefined;

      const contributions: { factor: string; impact: number; detail: string }[] = [];
      const add = (factor: keyof typeof DEFAULT_WEIGHTS, x: number, detail: string) => {
        const impact = W[factor] * x;
        if (impact !== 0) contributions.push({ factor, impact, detail });
      };

      if (sinceVisit !== undefined && sinceVisit > 7) add("days_since_last_visit", Math.min(sinceVisit, 60) - 7, `${sinceVisit} days since last visit`);
      if (trend !== undefined && trend < -20) add("visit_drop_pct", Math.min(-trend, 100) - 20, `Visits down ${-trend}% vs previous 30 days`);
      if (last30 !== undefined && last30 < 4) add("low_frequency", 1, `Only ${last30} visit(s) in 30 days`);
      if (tenure < 90) add("new_member", 1, `New member (${tenure} days)`);
      if (m.no_shows_30d) add("no_shows", m.no_shows_30d, `${m.no_shows_30d} no-show(s) in 30 days`);
      if (m.payment_failures_90d) add("payment_failures", m.payment_failures_90d, `${m.payment_failures_90d} failed payment(s)`);
      if (m.freeze_requests_90d) add("freeze_requests", 1, "Requested a freeze recently");
      if (m.open_complaints) add("open_complaints", m.open_complaints, `${m.open_complaints} open complaint(s)`);
      if (m.contract_end) {
        const left = daysBetween(new Date(m.contract_end), now);
        if (left >= 0 && left <= 30) add("contract_ending_soon", 1, `Contract ends in ${left} days`);
      }
      if (m.nps !== undefined && m.nps <= 6) add("low_nps", 1, `NPS ${m.nps} (detractor)`);
      if (m.nps !== undefined && m.nps >= 9) add("promoter", 1, `NPS ${m.nps} (promoter)`);
      if (m.referrals) add("referrals", Math.min(m.referrals, 3), `Referred ${m.referrals} member(s)`);
      if (m.last_app_session_at && daysBetween(now, new Date(m.last_app_session_at)) > 14) add("app_inactive", 1, "No app activity in 14+ days");

      const logit = W.intercept + contributions.reduce((a, c) => a + c.impact, 0);
      const p = 1 / (1 + Math.exp(-logit));
      const risk = Math.round(p * 100);
      const band = risk >= thresholds.critical ? "critical" : risk >= thresholds.high ? "high" : risk >= thresholds.medium ? "medium" : "low";
      revenueAtRisk += m.monthly_value * p;

      const drivers = contributions
        .filter((c) => c.impact > 0)
        .sort((a, b) => b.impact - a.impact)
        .slice(0, 4)
        .map((c) => ({ ...c, impact: Math.round(c.impact * 100) / 100 }));
      drivers.forEach((d) => driverCount.set(d.factor, (driverCount.get(d.factor) ?? 0) + 1));
      const actions = band === "low" ? [] : drivers.map((d) => PLAYBOOK[d.factor]).filter(Boolean).slice(0, 3);

      return {
        id: m.id,
        name: m.name,
        risk_score: risk,
        risk_band: band as "low" | "medium" | "high" | "critical",
        drivers,
        actions,
        signals: { days_since_last_visit: sinceVisit, visits_last_30d: last30, visit_trend_pct: trend, tenure_days: tenure },
      };
    });

    scored.sort((a, b) => b.risk_score - a.risk_score);
    const byBand = { low: 0, medium: 0, high: 0, critical: 0 };
    scored.forEach((s) => byBand[s.risk_band]++);

    return {
      members: scored,
      summary: {
        total: scored.length,
        by_band: byBand,
        monthly_revenue_at_risk: Math.round(revenueAtRisk * 100) / 100,
        top_drivers: [...driverCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([factor, n]) => ({ factor, members: n })),
      },
    };
  },
});
