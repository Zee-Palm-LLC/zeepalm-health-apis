import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";

/**
 * AI meal plans that hit macro targets, plus deterministic guardrails:
 * daily totals are recomputed in code and every ingredient is scanned
 * against the client's allergies.
 */

/** Ingredient keywords per allergen. Extend for your cuisine / market. */
const ALLERGEN_KEYWORDS: Record<string, string[]> = {
  peanut: ["peanut", "groundnut", "satay"],
  tree_nut: ["almond", "cashew", "walnut", "pecan", "pistachio", "hazelnut", "macadamia", "brazil nut", "pine nut", "praline", "marzipan"],
  dairy: ["milk", "cheese", "butter", "cream", "yogurt", "yoghurt", "whey", "casein", "ghee", "paneer", "curd", "kefir", "labneh", "ricotta"],
  egg: ["egg", "mayonnaise", "mayo", "meringue", "albumin"],
  gluten: ["wheat", "barley", "rye", "flour", "bread", "pasta", "couscous", "semolina", "bulgur", "seitan", "roti", "naan", "chapati", "spelt", "tortilla"],
  soy: ["soy", "soya", "tofu", "tempeh", "edamame", "miso"],
  fish: ["salmon", "tuna", "cod", "sardine", "anchov", "mackerel", "tilapia", "fish"],
  shellfish: ["shrimp", "prawn", "crab", "lobster", "mussel", "clam", "oyster", "scallop", "squid"],
  sesame: ["sesame", "tahini", "hummus"],
};
const normaliseAllergy = (a: string) => {
  const k = a.toLowerCase().replace(/[\s-]+/g, "_").replace(/s$/, "");
  return k === "nut" || k === "tree_nuts" ? "tree_nut" : k === "milk" || k === "lactose" ? "dairy" : k === "wheat" ? "gluten" : k;
};

const Input = z.object({
  targets: z.object({
    kcal: z.number().min(800).max(6000),
    protein_g: z.number().min(0),
    carbs_g: z.number().min(0),
    fat_g: z.number().min(0),
    fiber_g: z.number().min(0).optional(),
  }).describe("Paste `target_kcal` + `macros` from /nutrition-targets."),
  days: z.number().int().min(1).max(7).default(3),
  meals_per_day: z.number().int().min(2).max(6).default(4),
  diet: z.array(z.string()).default([]).describe('e.g. ["halal", "vegetarian", "low_fodmap", "diabetic_friendly"]'),
  allergies: z.array(z.string()).default([]).describe('e.g. ["peanut", "dairy", "gluten", "shellfish"]'),
  dislikes: z.array(z.string()).default([]),
  cuisines: z.array(z.string()).default([]).describe('e.g. ["Pakistani", "Mediterranean"]'),
  budget: z.enum(["low", "medium", "high"]).default("medium"),
  max_prep_minutes: z.number().int().min(5).max(180).default(30),
  region: z.string().optional().describe("Country/region so ingredients are locally available."),
});

const Meal = z.object({
  slot: z.string().describe("breakfast, lunch, snack, dinner..."),
  name: z.string(),
  ingredients: z.array(z.object({ item: z.string(), quantity: z.number(), unit: z.string() })),
  kcal: z.number(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
  prep_minutes: z.number(),
  method: z.string(),
});

const AIPlan = z.object({
  days: z.array(z.object({ day: z.number(), meals: z.array(Meal) })),
  grocery_list: z.array(z.object({ category: z.string(), items: z.array(z.object({ item: z.string(), quantity: z.number(), unit: z.string() })) })),
  tips: z.array(z.string()),
});

const Totals = z.object({ kcal: z.number(), protein_g: z.number(), carbs_g: z.number(), fat_g: z.number() });

const Output = z.object({
  days: z.array(z.object({ day: z.number(), meals: z.array(Meal), totals: Totals, deviation_pct: Totals })),
  grocery_list: AIPlan.shape.grocery_list,
  tips: z.array(z.string()),
  allergen_check: z.object({
    checked: z.array(z.string()),
    passed: z.boolean(),
    conflicts: z.array(z.object({ day: z.number(), meal: z.string(), ingredient: z.string(), allergen: z.string() })),
  }),
});

const sum = (meals: z.infer<typeof Meal>[]) =>
  meals.reduce((t, m) => ({ kcal: t.kcal + m.kcal, protein_g: t.protein_g + m.protein_g, carbs_g: t.carbs_g + m.carbs_g, fat_g: t.fat_g + m.fat_g }), { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 });

export default defineEndpoint({
  slug: "meal-plan",
  title: "AI Meal Plan Generator",
  summary: "Macro-matched multi-day meal plan with grocery list, cuisine and budget preferences, and a deterministic allergen check.",
  category: "ai",
  usesAI: true,
  zeePalmServices: ["AI Coach Assistant", "Coaching Platform Setup", "Custom GPT / Brand Assistant", "Ebook / Lead Magnet Design"],
  input: Input,
  output: Output,
  disclaimer: "AI-generated meal suggestions. Always check labels for allergens. Not medical nutrition therapy.",
  exampleInput: {
    targets: { kcal: 1850, protein_g: 130, carbs_g: 190, fat_g: 62 },
    days: 1,
    meals_per_day: 4,
    diet: ["halal"],
    allergies: ["peanut"],
    cuisines: ["Pakistani", "Mediterranean"],
    budget: "medium",
    max_prep_minutes: 30,
    region: "Pakistan",
  },
  async run(input, { ai }) {
    const plan = await ai.generate({
      system: `You are a registered dietitian creating practical meal plans for a nutrition app.
- Each day must land within ±5% of the kcal target and ±10% of each macro.
- Never use an ingredient containing a listed allergen, including hidden sources (sauces, pastes, oils).
- Respect diet rules, dislikes, budget, region availability and max prep time.
- Use realistic portions with per-meal macros calculated from the ingredients.
- The grocery list must combine every day's ingredients, grouped by aisle.`,
      prompt: `<input>\n${JSON.stringify(input, null, 2)}\n</input>\nReturn ${input.days} day(s) with ${input.meals_per_day} meals each.`,
      schema: AIPlan,
    });

    const allergens = [...new Set(input.allergies.map(normaliseAllergy))];
    const conflicts: z.infer<typeof Output>["allergen_check"]["conflicts"] = [];
    const days = plan.days.map((d) => {
      for (const meal of d.meals) {
        for (const ing of meal.ingredients) {
          const name = ing.item.toLowerCase();
          for (const a of allergens) {
            const words = ALLERGEN_KEYWORDS[a] ?? [a.replace(/_/g, " ")];
            // "peanut-free", "dairy free" etc. are fine.
            if (words.some((w) => name.includes(w)) && !/\b(free|vegan|plant[- ]based)\b/.test(name)) {
              conflicts.push({ day: d.day, meal: meal.name, ingredient: ing.item, allergen: a });
            }
          }
        }
      }
      const totals = sum(d.meals);
      const dev = (v: number, t: number) => (t ? Math.round(((v - t) / t) * 1000) / 10 : 0);
      return {
        ...d,
        totals: { kcal: Math.round(totals.kcal), protein_g: Math.round(totals.protein_g), carbs_g: Math.round(totals.carbs_g), fat_g: Math.round(totals.fat_g) },
        deviation_pct: {
          kcal: dev(totals.kcal, input.targets.kcal),
          protein_g: dev(totals.protein_g, input.targets.protein_g),
          carbs_g: dev(totals.carbs_g, input.targets.carbs_g),
          fat_g: dev(totals.fat_g, input.targets.fat_g),
        },
      };
    });

    return { days, grocery_list: plan.grocery_list, tips: plan.tips, allergen_check: { checked: allergens, passed: conflicts.length === 0, conflicts } };
  },
  exampleOutput: {
    days: [
      {
        day: 1,
        meals: [
          { slot: "breakfast", name: "Masala egg-white omelette with paratha-style whole-wheat roti", ingredients: [{ item: "egg whites", quantity: 200, unit: "g" }, { item: "whole egg", quantity: 1, unit: "pc" }, { item: "onion, tomato, green chilli", quantity: 80, unit: "g" }, { item: "whole-wheat roti", quantity: 1, unit: "pc" }, { item: "olive oil", quantity: 5, unit: "ml" }], kcal: 410, protein_g: 34, carbs_g: 38, fat_g: 12, prep_minutes: 15, method: "Sauté the veg in oil, add the whisked eggs, fold, and serve with a warm roti." },
          { slot: "lunch", name: "Chicken tikka bowl with brown rice and kachumber", ingredients: [{ item: "chicken breast", quantity: 150, unit: "g" }, { item: "low-fat yogurt (marinade)", quantity: 50, unit: "g" }, { item: "brown rice (cooked)", quantity: 180, unit: "g" }, { item: "cucumber, tomato, onion", quantity: 150, unit: "g" }], kcal: 560, protein_g: 46, carbs_g: 62, fat_g: 12, prep_minutes: 25, method: "Marinate the chicken in yogurt and tikka spices, grill it, and serve over rice with the salad." },
          { slot: "snack", name: "Greek yogurt with berries and chia", ingredients: [{ item: "Greek yogurt 2%", quantity: 170, unit: "g" }, { item: "mixed berries", quantity: 100, unit: "g" }, { item: "chia seeds", quantity: 10, unit: "g" }], kcal: 230, protein_g: 18, carbs_g: 22, fat_g: 7, prep_minutes: 3, method: "Layer and serve." },
          { slot: "dinner", name: "Daal masoor with grilled fish and salad", ingredients: [{ item: "red lentils (dry)", quantity: 60, unit: "g" }, { item: "tilapia fillet", quantity: 140, unit: "g" }, { item: "mixed salad", quantity: 120, unit: "g" }, { item: "olive oil", quantity: 15, unit: "ml" }], kcal: 650, protein_g: 40, carbs_g: 64, fat_g: 28, prep_minutes: 30, method: "Pressure-cook the daal with spices, pan-grill the fish, and dress the salad." },
        ],
      },
    ],
    grocery_list: [
      { category: "Protein", items: [{ item: "chicken breast", quantity: 150, unit: "g" }, { item: "tilapia fillet", quantity: 140, unit: "g" }, { item: "eggs", quantity: 7, unit: "pc" }] },
      { category: "Dairy", items: [{ item: "Greek yogurt 2%", quantity: 220, unit: "g" }] },
      { category: "Grains & pulses", items: [{ item: "brown rice", quantity: 60, unit: "g" }, { item: "red lentils", quantity: 60, unit: "g" }, { item: "whole-wheat atta", quantity: 40, unit: "g" }] },
      { category: "Produce", items: [{ item: "onion, tomato, cucumber, chillies", quantity: 1, unit: "kg" }, { item: "mixed berries", quantity: 100, unit: "g" }] },
    ],
    tips: ["Batch-grill the chicken for 2 days.", "Swap the tilapia for chicken if fish is pricey this week."],
  },
});
