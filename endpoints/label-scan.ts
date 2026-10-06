import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";

/**
 * Photo of a supplement facts or nutrition facts label → structured JSON,
 * then deterministic checks: adult tolerable upper limits (per daily dose),
 * allergens, caffeine and proprietary blends.
 */

/** Adult Tolerable Upper Intake Levels (NIH ODS / NAM), supplemental where noted. Units must match the label unit. */
const UPPER_LIMITS: { match: RegExp; limit: number; unit: string; note: string }[] = [
  { match: /vitamin d/i, limit: 100, unit: "mcg", note: "4,000 IU/day" },
  { match: /vitamin a/i, limit: 3000, unit: "mcg", note: "preformed vitamin A (RAE)" },
  { match: /vitamin e/i, limit: 1000, unit: "mg", note: "supplemental alpha-tocopherol" },
  { match: /vitamin c/i, limit: 2000, unit: "mg", note: "" },
  { match: /vitamin b6|pyridoxine/i, limit: 100, unit: "mg", note: "" },
  { match: /niacin|vitamin b3/i, limit: 35, unit: "mg", note: "supplemental niacin" },
  { match: /folate|folic acid/i, limit: 1000, unit: "mcg", note: "synthetic folic acid (DFE labels may read higher)" },
  { match: /^iron\b/i, limit: 45, unit: "mg", note: "" },
  { match: /^zinc\b/i, limit: 40, unit: "mg", note: "" },
  { match: /^calcium\b/i, limit: 2500, unit: "mg", note: "ages 19-50" },
  { match: /^magnesium\b/i, limit: 350, unit: "mg", note: "supplemental magnesium" },
  { match: /^selenium\b/i, limit: 400, unit: "mcg", note: "" },
  { match: /^iodine\b/i, limit: 1100, unit: "mcg", note: "" },
  { match: /^copper\b/i, limit: 10, unit: "mg", note: "" },
  { match: /caffeine/i, limit: 400, unit: "mg", note: "healthy adults; 200 mg in pregnancy" },
];
const toUnit = (amount: number, from: string, to: string): number | undefined => {
  const f = from.toLowerCase().replace("µg", "mcg").replace("ug", "mcg");
  if (f === to) return amount;
  if (f === "g" && to === "mg") return amount * 1000;
  if (f === "mg" && to === "mcg") return amount * 1000;
  if (f === "mcg" && to === "mg") return amount / 1000;
  if (f === "iu" && to === "mcg") return undefined; // IU conversion depends on the nutrient
  return undefined;
};

const Input = z
  .object({
    image_url: z.url().optional().describe("Public https URL of the label photo."),
    image_base64: z.string().optional().describe("Base64 image (no data: prefix). Max ~5 MB."),
    media_type: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]).default("image/jpeg"),
    label_type: z.enum(["auto", "supplement", "nutrition"]).default("auto"),
    servings_per_day: z.number().min(0.25).max(20).default(1).describe("Used to compare the daily dose against upper limits."),
    allergies: z.array(z.string()).default([]),
  })
  .refine((v) => v.image_url || v.image_base64, { message: "Provide image_url or image_base64", path: ["image_url"] });

const Nutrient = z.object({
  name: z.string(),
  amount: z.number().optional(),
  unit: z.string().optional(),
  daily_value_pct: z.number().optional(),
  form: z.string().optional().describe('Chemical form if stated, e.g. "as cholecalciferol"'),
});

const AIOut = z.object({
  label_type: z.enum(["supplement", "nutrition", "unknown"]),
  product_name: z.string().optional(),
  brand: z.string().optional(),
  serving_size: z.string().optional(),
  servings_per_container: z.number().optional(),
  calories_per_serving: z.number().optional(),
  nutrients: z.array(Nutrient),
  proprietary_blends: z.array(z.object({ name: z.string(), total_amount: z.string().optional(), ingredients: z.array(z.string()) })),
  ingredients: z.array(z.string()).describe("Full ingredients / other ingredients list in order."),
  allergen_statement: z.string().optional(),
  label_warnings: z.array(z.string()),
  certifications: z.array(z.string()).describe("e.g. NSF Certified for Sport, Informed Sport, Halal, Vegan, GMP"),
  legibility: z.enum(["clear", "partial", "poor"]),
});

const Output = AIOut.extend({
  flags: z.array(z.object({ type: z.enum(["upper_limit", "allergen", "caffeine", "proprietary_blend", "legibility"]), severity: z.enum(["info", "warning", "high"]), message: z.string() })),
});

export default defineEndpoint({
  slug: "label-scan",
  title: "AI Supplement & Nutrition Label Scanner",
  summary: "Extract a supplement or nutrition facts label from a photo into JSON, then flag upper-limit overdoses, allergens, caffeine and proprietary blends.",
  category: "ai",
  usesAI: true,
  zeePalmServices: ["Computer Vision", "Supplement Label", "Amazon A+ Content", "Shopify Store", "AI Chatbot (E-commerce)"],
  input: Input,
  output: Output,
  disclaimer: "Extraction can contain errors. Always verify against the physical label. Upper limits are for healthy adults.",
  exampleInput: {
    image_url: "https://example.com/replace-with-your-label-photo.jpg",
    label_type: "auto",
    servings_per_day: 1,
    allergies: ["soy"],
  },
  async run(input, { ai }) {
    const out = await ai.generate({
      system: `You extract data from photos of supplement facts and nutrition facts labels.
- Transcribe exactly what is printed. Do not guess missing values; leave them out and lower legibility.
- Keep units exactly as printed (mg, mcg, g, IU, kcal).
- List proprietary blends separately with their component ingredients.
- If the image is not a label, return label_type "unknown" with empty lists.`,
      prompt: `Extract this ${input.label_type === "auto" ? "label" : `${input.label_type} label`}.`,
      images: [input.image_url ? { url: input.image_url } : { base64: input.image_base64!, media_type: input.media_type }],
      schema: AIOut,
      maxTokens: 8000,
    });

    const flags: z.infer<typeof Output>["flags"] = [];
    for (const n of out.nutrients) {
      const ul = UPPER_LIMITS.find((u) => u.match.test(n.name.trim()));
      if (!ul || n.amount === undefined || !n.unit) continue;
      const perServing = toUnit(n.amount, n.unit, ul.unit);
      if (perServing === undefined) continue;
      const daily = perServing * input.servings_per_day;
      if (daily > ul.limit) {
        flags.push({
          type: ul.match.source.includes("caffeine") ? "caffeine" : "upper_limit",
          severity: daily > ul.limit * 1.5 ? "high" : "warning",
          message: `${n.name}: ${Math.round(daily * 10) / 10} ${ul.unit}/day exceeds the adult upper limit of ${ul.limit} ${ul.unit}${ul.note ? ` (${ul.note})` : ""}.`,
        });
      } else if (ul.match.source.includes("caffeine") && perServing >= 150) {
        flags.push({ type: "caffeine", severity: "info", message: `${perServing} mg caffeine per serving. Avoid within 6 hours of sleep.` });
      }
    }
    const haystack = [...out.ingredients, out.allergen_statement ?? "", ...out.proprietary_blends.flatMap((b) => b.ingredients)].join(" | ").toLowerCase();
    for (const a of input.allergies) {
      const key = a.toLowerCase().replace(/s$/, "");
      if (haystack.includes(key)) flags.push({ type: "allergen", severity: "high", message: `Contains or may contain "${a}".` });
    }
    for (const b of out.proprietary_blends) {
      flags.push({ type: "proprietary_blend", severity: "info", message: `"${b.name}" is a proprietary blend: individual ingredient doses are not disclosed.` });
    }
    if (out.legibility !== "clear") flags.push({ type: "legibility", severity: "warning", message: "Parts of the label were hard to read. Retake the photo in better light and face-on." });

    return { ...out, flags };
  },
  exampleOutput: {
    label_type: "supplement",
    product_name: "Pre-Workout Ignite",
    brand: "Example Labs",
    serving_size: "1 scoop (12 g)",
    servings_per_container: 30,
    calories_per_serving: 10,
    nutrients: [
      { name: "Vitamin B6", amount: 25, unit: "mg", daily_value_pct: 1471, form: "as pyridoxine HCl" },
      { name: "Vitamin D3", amount: 125, unit: "mcg", daily_value_pct: 625, form: "as cholecalciferol" },
      { name: "Caffeine", amount: 300, unit: "mg" },
    ],
    proprietary_blends: [{ name: "Focus Matrix", total_amount: "1.2 g", ingredients: ["L-tyrosine", "Alpha-GPC", "Huperzine A"] }],
    ingredients: ["Citric acid", "Natural flavours", "Sucralose", "Soy lecithin", "Silicon dioxide"],
    allergen_statement: "Contains soy. Made in a facility that processes milk.",
    label_warnings: ["Not for use by individuals under 18", "Do not exceed 1 scoop in 24 hours"],
    certifications: ["GMP"],
    legibility: "clear",
  },
});
