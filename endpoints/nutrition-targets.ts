import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";
import { ApiError } from "@/lib/errors";

const CONFIG = {
  activityFactors: { sedentary: 1.2, light: 1.375, moderate: 1.55, very: 1.725, athlete: 1.9 },
  kcalPerKgBodyMass: 7700,
  defaultRatePctPerWeek: { lose: 0.5, maintain: 0, gain: 0.25, recomp: 0 },
  recompDeficitPct: 0.1,
  proteinGPerKg: { lose: 2.0, maintain: 1.6, gain: 1.8, recomp: 2.2 },
  proteinGPerKgLeanMass: 2.6,
  fatMinGPerKg: 0.6,
  fatPctByStyle: { balanced: 0.3, high_protein: 0.3, low_carb: 0.45, keto: 0.7, plant_based: 0.3, endurance: 0.25 },
  ketoCarbCapG: 40,
  fiberGPer1000Kcal: 14,
  waterMlPerKg: 35,
  waterMlPerTrainingHour: 500,
  minKcal: { female: 1200, male: 1500 },
};

const Input = z
  .object({
    sex: z.enum(["female", "male"]).describe("Sex used by the BMR equations."),
    age: z.number().int().min(14).max(100),
    height_cm: z.number().min(100).max(250).optional(),
    height_in: z.number().min(40).max(100).optional(),
    weight_kg: z.number().min(30).max(350).optional(),
    weight_lb: z.number().min(66).max(770).optional(),
    body_fat_pct: z.number().min(3).max(65).optional().describe("Enables Katch-McArdle BMR and lean-mass-based protein."),
    activity_level: z.enum(["sedentary", "light", "moderate", "very", "athlete"]).default("moderate"),
    training_hours_per_week: z.number().min(0).max(40).default(3),
    goal: z.enum(["lose", "maintain", "gain", "recomp"]),
    rate_pct_bodyweight_per_week: z.number().min(0).max(1.5).optional().describe("Weekly change as % of bodyweight. Defaults: lose 0.5, gain 0.25."),
    diet_style: z.enum(["balanced", "high_protein", "low_carb", "keto", "plant_based", "endurance"]).default("balanced"),
  })
  .refine((v) => v.height_cm || v.height_in, { message: "Provide height_cm or height_in", path: ["height_cm"] })
  .refine((v) => v.weight_kg || v.weight_lb, { message: "Provide weight_kg or weight_lb", path: ["weight_kg"] });

const Output = z.object({
  bmr: z.object({ kcal: z.number(), equation: z.enum(["mifflin_st_jeor", "katch_mcardle"]), mifflin_st_jeor: z.number(), katch_mcardle: z.number().optional() }),
  tdee_kcal: z.number(),
  target_kcal: z.number(),
  daily_adjustment_kcal: z.number(),
  macros: z.object({
    protein_g: z.number(),
    carbs_g: z.number(),
    fat_g: z.number(),
    fiber_g: z.number(),
    split_pct: z.object({ protein: z.number(), carbs: z.number(), fat: z.number() }),
  }),
  hydration_ml: z.number(),
  body: z.object({
    bmi: z.number(),
    bmi_category: z.enum(["underweight", "healthy", "overweight", "obese"]),
    lean_mass_kg: z.number().optional(),
    ffmi: z.number().optional(),
  }),
  projection: z.object({ weekly_change_kg: z.number(), weeks_to_lose_or_gain_5kg: z.number().optional() }),
  warnings: z.array(z.string()),
});

const round = (n: number, step = 1) => Math.round(n / step) * step;

export default defineEndpoint({
  slug: "nutrition-targets",
  title: "Nutrition Targets Calculator",
  summary: "BMR, TDEE, calorie target, macros, fibre, hydration and body metrics from a client profile. Metric or imperial.",
  category: "nutrition",
  usesAI: false,
  zeePalmServices: ["Coaching Platform Setup", "Gym Platform Setup", "Coach Launch", "AI Coach Assistant"],
  input: Input,
  output: Output,
  disclaimer: "General guidance for healthy adults. Pregnancy, eating disorders, diabetes and kidney disease need individual clinical advice.",
  exampleInput: { sex: "female", age: 32, height_cm: 165, weight_kg: 72, body_fat_pct: 31, activity_level: "moderate", training_hours_per_week: 4, goal: "lose", diet_style: "high_protein" },
  run(i) {
    const height = i.height_cm ?? i.height_in! * 2.54;
    const weight = i.weight_kg ?? i.weight_lb! * 0.453592;
    const warnings: string[] = [];
    if (i.age < 18) warnings.push("Under 18: use growth-appropriate targets, not deficits. Refer to a paediatric dietitian.");

    const mifflin = 10 * weight + 6.25 * height - 5 * i.age + (i.sex === "male" ? 5 : -161);
    const lean = i.body_fat_pct ? weight * (1 - i.body_fat_pct / 100) : undefined;
    const katch = lean ? 370 + 21.6 * lean : undefined;
    const bmr = katch ?? mifflin;

    const tdee = bmr * CONFIG.activityFactors[i.activity_level];
    const rate = i.rate_pct_bodyweight_per_week ?? CONFIG.defaultRatePctPerWeek[i.goal];
    const weeklyKg = i.goal === "maintain" || i.goal === "recomp" ? 0 : (weight * rate) / 100;
    let adjustment = i.goal === "lose" ? -(weeklyKg * CONFIG.kcalPerKgBodyMass) / 7 : i.goal === "gain" ? (weeklyKg * CONFIG.kcalPerKgBodyMass) / 7 : 0;
    if (i.goal === "recomp") adjustment = -tdee * CONFIG.recompDeficitPct;

    let target = tdee + adjustment;
    const floor = Math.max(CONFIG.minKcal[i.sex], bmr);
    if (i.goal === "lose" && target < floor) {
      warnings.push(`Target raised to ${round(floor, 10)} kcal: the requested rate would go below BMR or the safe minimum. Expect slower loss.`);
      target = floor;
      adjustment = target - tdee;
    }
    if (rate > 1) warnings.push("Losing or gaining more than 1% of bodyweight per week risks muscle loss. Supervise closely.");

    const proteinG = Math.min(
      lean ? lean * CONFIG.proteinGPerKgLeanMass : Infinity,
      weight * (i.diet_style === "high_protein" ? CONFIG.proteinGPerKg[i.goal] + 0.2 : CONFIG.proteinGPerKg[i.goal]),
    );
    let fatG = Math.max((target * CONFIG.fatPctByStyle[i.diet_style]) / 9, weight * CONFIG.fatMinGPerKg);
    let carbsG = (target - proteinG * 4 - fatG * 9) / 4;
    if (i.diet_style === "keto" && carbsG > CONFIG.ketoCarbCapG) {
      carbsG = CONFIG.ketoCarbCapG;
      fatG = (target - proteinG * 4 - carbsG * 4) / 9;
    }
    if (carbsG < 0) throw new ApiError(422, "infeasible_targets", "Protein and fat minimums exceed the calorie target. Raise the target or lower the rate.");

    const kcal = proteinG * 4 + carbsG * 4 + fatG * 9;
    const bmi = weight / (height / 100) ** 2;
    const bmiCategory = (bmi < 18.5 ? "underweight" : bmi < 25 ? "healthy" : bmi < 30 ? "overweight" : "obese") as "underweight" | "healthy" | "overweight" | "obese";
    if (bmiCategory === "underweight" && i.goal === "lose") warnings.push("BMI is under 18.5. A deficit is not recommended.");

    return {
      bmr: { kcal: round(bmr), equation: katch ? ("katch_mcardle" as const) : ("mifflin_st_jeor" as const), mifflin_st_jeor: round(mifflin), katch_mcardle: katch && round(katch) },
      tdee_kcal: round(tdee, 10),
      target_kcal: round(target, 10),
      daily_adjustment_kcal: round(adjustment, 10),
      macros: {
        protein_g: round(proteinG, 5),
        carbs_g: round(carbsG, 5),
        fat_g: round(fatG, 5),
        fiber_g: round((target / 1000) * CONFIG.fiberGPer1000Kcal),
        split_pct: { protein: round((proteinG * 400) / kcal), carbs: round((carbsG * 400) / kcal), fat: round((fatG * 900) / kcal) },
      },
      hydration_ml: round(weight * CONFIG.waterMlPerKg + (i.training_hours_per_week / 7) * CONFIG.waterMlPerTrainingHour, 50),
      body: {
        bmi: Math.round(bmi * 10) / 10,
        bmi_category: bmiCategory,
        lean_mass_kg: lean && Math.round(lean * 10) / 10,
        ffmi: lean && Math.round((lean / (height / 100) ** 2) * 10) / 10,
      },
      projection: {
        weekly_change_kg: Math.round(((adjustment * 7) / CONFIG.kcalPerKgBodyMass) * 100) / 100,
        weeks_to_lose_or_gain_5kg: adjustment ? Math.round(5 / Math.abs((adjustment * 7) / CONFIG.kcalPerKgBodyMass)) : undefined,
      },
      warnings,
    };
  },
});
