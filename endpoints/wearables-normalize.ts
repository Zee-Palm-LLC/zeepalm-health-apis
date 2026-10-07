import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";
import { ApiError } from "@/lib/errors";

const Sources = ["apple_health", "health_connect", "fitbit", "garmin", "oura", "whoop"] as const;

const Sleep = z.object({
  total_min: z.number().optional(),
  deep_min: z.number().optional(),
  rem_min: z.number().optional(),
  light_min: z.number().optional(),
  awake_min: z.number().optional(),
  efficiency_pct: z.number().optional(),
});

const Day = z.object({
  date: z.string().describe("YYYY-MM-DD"),
  steps: z.number().optional(),
  active_energy_kcal: z.number().optional(),
  resting_hr_bpm: z.number().optional(),
  avg_hr_bpm: z.number().optional(),
  hrv_rmssd_ms: z.number().optional(),
  spo2_pct: z.number().optional(),
  respiratory_rate: z.number().optional(),
  vo2max: z.number().optional(),
  sleep: Sleep.optional(),
  vendor_scores: z.record(z.string(), z.number()).optional().describe("Vendor-specific scores kept as-is (e.g. whoop_recovery, oura_readiness)."),
});

type DayRow = z.infer<typeof Day>;

const Input = z.object({
  source: z.enum(Sources),
  data: z.unknown().describe("Raw payload exactly as returned by the vendor API / SDK. See README for accepted shapes."),
  timezone: z.string().default("UTC").describe("IANA timezone used to bucket timestamps into days, e.g. Asia/Karachi."),
});

const Output = z.object({
  source: z.enum(Sources),
  timezone: z.string(),
  days: z.array(Day),
  coverage: z.object({
    days: z.number(),
    first_date: z.string().optional(),
    last_date: z.string().optional(),
    metrics_present: z.array(z.string()),
  }),
  warnings: z.array(z.string()),
});

type Obj = Record<string, unknown>;
const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const r1 = (n: number | undefined) => (n === undefined ? undefined : Math.round(n * 10) / 10);

function dayKey(ts: unknown, tz: string): string | undefined {
  if (typeof ts !== "string" && typeof ts !== "number") return undefined;
  if (typeof ts === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ts)) return ts;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const minutesBetween = (a: unknown, b: unknown) => (new Date(String(b)).getTime() - new Date(String(a)).getTime()) / 60000;

class DayBook {
  private days = new Map<string, DayRow>();
  private avgs = new Map<string, { sum: number; n: number }>();
  get(date: string): DayRow {
    let d = this.days.get(date);
    if (!d) this.days.set(date, (d = { date }));
    return d;
  }
  set(date: string | undefined, key: keyof DayRow, value: number | undefined) {
    if (!date || value === undefined) return;
    (this.get(date) as Obj)[key] = value;
  }
  add(date: string | undefined, key: "steps" | "active_energy_kcal", value: number | undefined) {
    if (!date || value === undefined) return;
    const d = this.get(date);
    d[key] = (d[key] ?? 0) + value;
  }
  avg(date: string | undefined, key: "resting_hr_bpm" | "avg_hr_bpm" | "hrv_rmssd_ms" | "spo2_pct" | "respiratory_rate" | "vo2max", value: number | undefined) {
    if (!date || value === undefined) return;
    const k = `${date}|${key}`;
    const a = this.avgs.get(k) ?? { sum: 0, n: 0 };
    a.sum += value;
    a.n += 1;
    this.avgs.set(k, a);
    this.get(date)[key] = a.sum / a.n;
  }
  sleep(date: string | undefined, key: keyof z.infer<typeof Sleep>, value: number | undefined, mode: "add" | "set" = "add") {
    if (!date || value === undefined) return;
    const d = this.get(date);
    d.sleep ??= {};
    d.sleep[key] = mode === "add" ? (d.sleep[key] ?? 0) + value : value;
  }
  score(date: string | undefined, key: string, value: number | undefined) {
    if (!date || value === undefined) return;
    const d = this.get(date);
    d.vendor_scores = { ...d.vendor_scores, [key]: value };
  }
  rows(): DayRow[] {
    return [...this.days.values()].sort((a, b) => a.date.localeCompare(b.date));
  }
}

type Mapper = (data: unknown, tz: string, book: DayBook, warn: (m: string) => void) => void;

const appleHealth: Mapper = (data, tz, book, warn) => {
  const samples = Array.isArray(data) ? arr(data) : arr(obj(data).samples);
  const unknown = new Set<string>();
  for (const s of samples) {
    const type = String(s.type ?? "").replace(/^HK(Quantity|Category)TypeIdentifier/, "");
    const date = dayKey(type === "SleepAnalysis" ? s.endDate : s.startDate, tz);
    const v = num(s.value);
    switch (type) {
      case "StepCount": book.add(date, "steps", v); break;
      case "ActiveEnergyBurned": book.add(date, "active_energy_kcal", s.unit === "kJ" && v ? v / 4.184 : v); break;
      case "RestingHeartRate": book.avg(date, "resting_hr_bpm", v); break;
      case "HeartRate": book.avg(date, "avg_hr_bpm", v); break;
      case "HeartRateVariabilitySDNN":
        book.avg(date, "hrv_rmssd_ms", v);
        unknown.add("HRV from Apple Health is SDNN, used as an RMSSD proxy");
        break;
      case "OxygenSaturation": book.avg(date, "spo2_pct", v !== undefined && v <= 1 ? v * 100 : v); break;
      case "RespiratoryRate": book.avg(date, "respiratory_rate", v); break;
      case "VO2Max": book.avg(date, "vo2max", v); break;
      case "SleepAnalysis": {
        const mins = minutesBetween(s.startDate, s.endDate);
        const stage = String(s.value ?? "");
        if (/Deep/.test(stage)) book.sleep(date, "deep_min", mins);
        else if (/REM/.test(stage)) book.sleep(date, "rem_min", mins);
        else if (/Core|Asleep/.test(stage)) book.sleep(date, "light_min", mins);
        else if (/Awake/.test(stage)) book.sleep(date, "awake_min", mins);
        break;
      }
      default: if (type) unknown.add(`Ignored HealthKit type ${type}`);
    }
  }
  unknown.forEach(warn);
};

const healthConnect: Mapper = (data, tz, book, warn) => {
  const records = Array.isArray(data) ? arr(data) : arr(obj(data).records);
  const STAGE: Record<number, "awake_min" | "light_min" | "deep_min" | "rem_min" | undefined> = { 1: "awake_min", 2: "light_min", 4: "light_min", 5: "deep_min", 6: "rem_min", 7: "awake_min" };
  for (const r of records) {
    const type = String(r.recordType ?? "");
    const date = dayKey(r.time ?? r.startTime, tz);
    switch (type) {
      case "StepsRecord": book.add(date, "steps", num(r.count)); break;
      case "ActiveCaloriesBurnedRecord": book.add(date, "active_energy_kcal", num(obj(r.energy).inKilocalories) ?? num(r.energy)); break;
      case "RestingHeartRateRecord": book.avg(date, "resting_hr_bpm", num(r.beatsPerMinute)); break;
      case "HeartRateVariabilityRmssdRecord": book.avg(date, "hrv_rmssd_ms", num(r.heartRateVariabilityMillis)); break;
      case "OxygenSaturationRecord": book.avg(date, "spo2_pct", num(obj(r.percentage).value) ?? num(r.percentage)); break;
      case "RespiratoryRateRecord": book.avg(date, "respiratory_rate", num(r.rate)); break;
      case "Vo2MaxRecord": book.avg(date, "vo2max", num(r.vo2MillilitersPerMinuteKilogram)); break;
      case "HeartRateRecord":
        for (const s of arr(r.samples)) book.avg(dayKey(s.time, tz), "avg_hr_bpm", num(s.beatsPerMinute));
        break;
      case "SleepSessionRecord": {
        const wake = dayKey(r.endTime, tz);
        const stages = arr(r.stages);
        if (!stages.length) book.sleep(wake, "light_min", minutesBetween(r.startTime, r.endTime));
        for (const st of stages) {
          const key = STAGE[num(st.stage) ?? 0];
          if (key) book.sleep(wake, key, minutesBetween(st.startTime, st.endTime));
        }
        break;
      }
      default: if (type) warn(`Ignored Health Connect record ${type}`);
    }
  }
};

const fitbit: Mapper = (data, _tz, book) => {
  const d = obj(data);
  for (const s of arr(d["activities-steps"])) book.set(dayKey(s.dateTime, "UTC"), "steps", num(s.value));
  for (const s of arr(d["activities-activityCalories"])) book.set(dayKey(s.dateTime, "UTC"), "active_energy_kcal", num(s.value));
  for (const s of arr(d["activities-heart"])) book.set(dayKey(s.dateTime, "UTC"), "resting_hr_bpm", num(obj(s.value).restingHeartRate));
  for (const s of arr(d.hrv)) book.set(dayKey(s.dateTime, "UTC"), "hrv_rmssd_ms", num(obj(s.value).dailyRmssd));
  for (const s of arr(d.spo2 ?? d["spo2"])) book.set(dayKey(s.dateTime, "UTC"), "spo2_pct", num(obj(s.value).avg));
  for (const s of arr(d.br)) book.set(dayKey(s.dateTime, "UTC"), "respiratory_rate", num(obj(s.value).breathingRate));
  for (const s of arr(d.sleep)) {
    if (s.isMainSleep === false) continue;
    const date = dayKey(s.dateOfSleep, "UTC");
    const sum = obj(obj(s.levels).summary);
    book.sleep(date, "total_min", num(s.minutesAsleep), "set");
    book.sleep(date, "efficiency_pct", num(s.efficiency), "set");
    book.sleep(date, "deep_min", num(obj(sum.deep).minutes), "set");
    book.sleep(date, "rem_min", num(obj(sum.rem).minutes), "set");
    book.sleep(date, "light_min", num(obj(sum.light).minutes), "set");
    book.sleep(date, "awake_min", num(obj(sum.wake).minutes), "set");
  }
};

const garmin: Mapper = (data, _tz, book) => {
  const d = obj(data);
  for (const s of arr(d.dailies)) {
    const date = dayKey(s.calendarDate, "UTC");
    book.set(date, "steps", num(s.steps));
    book.set(date, "active_energy_kcal", num(s.activeKilocalories));
    book.set(date, "resting_hr_bpm", num(s.restingHeartRateInBeatsPerMinute));
    book.set(date, "avg_hr_bpm", num(s.averageHeartRateInBeatsPerMinute));
  }
  for (const s of arr(d.sleeps)) {
    const date = dayKey(s.calendarDate, "UTC");
    const m = (v: unknown) => (num(v) === undefined ? undefined : num(v)! / 60);
    book.sleep(date, "deep_min", m(s.deepSleepDurationInSeconds), "set");
    book.sleep(date, "light_min", m(s.lightSleepDurationInSeconds), "set");
    book.sleep(date, "rem_min", m(s.remSleepInSeconds), "set");
    book.sleep(date, "awake_min", m(s.awakeDurationInSeconds), "set");
    book.score(date, "garmin_sleep_score", num(obj(obj(s.overallSleepScore)).value));
  }
  for (const s of arr(d.hrv)) book.set(dayKey(s.calendarDate, "UTC"), "hrv_rmssd_ms", num(s.lastNightAvg));
  for (const s of arr(d.pulseox ?? d.pulseOx)) book.set(dayKey(s.calendarDate, "UTC"), "spo2_pct", num(s.averageSpO2 ?? s.avgSpo2));
};

const oura: Mapper = (data, _tz, book) => {
  const d = obj(data);
  const list = (k: string) => (Array.isArray(d[k]) ? arr(d[k]) : arr(obj(d[k]).data));
  for (const s of list("daily_activity")) {
    book.set(dayKey(s.day, "UTC"), "steps", num(s.steps));
    book.set(dayKey(s.day, "UTC"), "active_energy_kcal", num(s.active_calories));
  }
  for (const s of list("sleep")) {
    if (s.type && s.type !== "long_sleep") continue;
    const date = dayKey(s.day, "UTC");
    const m = (v: unknown) => (num(v) === undefined ? undefined : num(v)! / 60);
    book.sleep(date, "total_min", m(s.total_sleep_duration), "set");
    book.sleep(date, "deep_min", m(s.deep_sleep_duration), "set");
    book.sleep(date, "rem_min", m(s.rem_sleep_duration), "set");
    book.sleep(date, "light_min", m(s.light_sleep_duration), "set");
    book.sleep(date, "awake_min", m(s.awake_time), "set");
    book.sleep(date, "efficiency_pct", num(s.efficiency), "set");
    book.set(date, "hrv_rmssd_ms", num(s.average_hrv));
    book.set(date, "resting_hr_bpm", num(s.lowest_heart_rate));
    book.set(date, "respiratory_rate", num(s.average_breath));
  }
  for (const s of list("daily_readiness")) book.score(dayKey(s.day, "UTC"), "oura_readiness", num(s.score));
  for (const s of list("daily_spo2")) book.set(dayKey(s.day, "UTC"), "spo2_pct", num(obj(s.spo2_percentage).average));
};

const whoop: Mapper = (data, tz, book) => {
  const d = obj(data);
  const list = (k: string) => (Array.isArray(d[k]) ? arr(d[k]) : arr(obj(d[k]).records));
  for (const r of list("recovery")) {
    const date = dayKey(r.created_at, tz);
    const s = obj(r.score);
    book.set(date, "resting_hr_bpm", num(s.resting_heart_rate));
    book.set(date, "hrv_rmssd_ms", num(s.hrv_rmssd_milli));
    book.set(date, "spo2_pct", num(s.spo2_percentage));
    book.score(date, "whoop_recovery", num(s.recovery_score));
  }
  for (const r of list("sleep")) {
    if (r.nap === true) continue;
    const date = dayKey(r.end, tz);
    const s = obj(r.score);
    const st = obj(s.stage_summary);
    const m = (v: unknown) => (num(v) === undefined ? undefined : num(v)! / 60000);
    book.sleep(date, "deep_min", m(st.total_slow_wave_sleep_time_milli), "set");
    book.sleep(date, "rem_min", m(st.total_rem_sleep_time_milli), "set");
    book.sleep(date, "light_min", m(st.total_light_sleep_time_milli), "set");
    book.sleep(date, "awake_min", m(st.total_awake_time_milli), "set");
    book.sleep(date, "efficiency_pct", num(s.sleep_efficiency_percentage), "set");
    book.set(date, "respiratory_rate", num(s.respiratory_rate));
  }
  for (const r of list("cycle")) {
    const date = dayKey(r.start, tz);
    const s = obj(r.score);
    const kj = num(s.kilojoule);
    book.set(date, "active_energy_kcal", kj === undefined ? undefined : kj / 4.184);
    book.score(date, "whoop_strain", num(s.strain));
  }
};

const MAPPERS: Record<(typeof Sources)[number], Mapper> = {
  apple_health: appleHealth,
  health_connect: healthConnect,
  fitbit,
  garmin,
  oura,
  whoop,
};

export default defineEndpoint({
  slug: "wearables-normalize",
  title: "Wearable Data Normalizer",
  summary: "Turn raw Apple Health, Health Connect, Fitbit, Garmin, Oura or WHOOP payloads into one clean daily schema.",
  category: "wearables",
  usesAI: false,
  zeePalmServices: ["Wearable Integrations", "Data Pipelines & Dashboards", "Gym Platform Setup", "Coaching Platform Setup"],
  input: Input,
  output: Output,
  exampleInput: {
    source: "oura",
    timezone: "Asia/Karachi",
    data: {
      daily_activity: { data: [{ day: "2026-10-05", steps: 9421, active_calories: 512 }] },
      sleep: {
        data: [
          {
            day: "2026-10-05",
            type: "long_sleep",
            total_sleep_duration: 26100,
            deep_sleep_duration: 5400,
            rem_sleep_duration: 6300,
            light_sleep_duration: 14400,
            awake_time: 2700,
            efficiency: 91,
            average_hrv: 58,
            lowest_heart_rate: 51,
            average_breath: 14.6,
          },
        ],
      },
      daily_readiness: { data: [{ day: "2026-10-05", score: 82 }] },
    },
  },
  run({ source, data, timezone }) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      throw new ApiError(422, "validation_error", `Unknown timezone "${timezone}".`);
    }
    const book = new DayBook();
    const warnings = new Set<string>();
    MAPPERS[source](data, timezone, book, (m) => warnings.add(m));

    const days = book.rows().map((d) => {
      if (d.sleep) {
        const s = d.sleep;
        const asleep = (s.deep_min ?? 0) + (s.rem_min ?? 0) + (s.light_min ?? 0);
        s.total_min ??= asleep || undefined;
        if (s.efficiency_pct === undefined && s.total_min && s.awake_min !== undefined) {
          s.efficiency_pct = (s.total_min / (s.total_min + s.awake_min)) * 100;
        }
        for (const k of Object.keys(s) as (keyof typeof s)[]) s[k] = r1(s[k]);
      }
      for (const k of ["active_energy_kcal", "resting_hr_bpm", "avg_hr_bpm", "hrv_rmssd_ms", "spo2_pct", "respiratory_rate", "vo2max"] as const) d[k] = r1(d[k]);
      return d;
    });

    if (!days.length) warnings.add(`No recognisable ${source} data found. Check the payload shape in the README.`);
    const metrics = new Set<string>();
    days.forEach((d) => Object.keys(d).forEach((k) => k !== "date" && metrics.add(k)));

    return {
      source,
      timezone,
      days,
      coverage: { days: days.length, first_date: days[0]?.date, last_date: days.at(-1)?.date, metrics_present: [...metrics].sort() },
      warnings: [...warnings],
    };
  },
});
