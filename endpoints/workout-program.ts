import { z } from "zod";
import { defineEndpoint } from "@/lib/endpoint";

const EQUIPMENT_PRESETS: Record<string, string[]> = {
  full_gym: ["barbell", "dumbbells", "cable machine", "machines", "pull-up bar", "bench", "squat rack", "cardio machines"],
  home_dumbbells: ["adjustable dumbbells", "bench", "resistance bands", "bodyweight"],
  bodyweight: ["bodyweight", "floor space"],
  hotel_gym: ["dumbbells up to 25 kg", "treadmill", "bench", "bodyweight"],
};

const Input = z.object({
  client: z.object({
    age: z.number().int().min(13).max(100).optional(),
    sex: z.enum(["female", "male", "other"]).optional(),
    experience: z.enum(["beginner", "intermediate", "advanced"]),
    goal: z.enum(["strength", "hypertrophy", "fat_loss", "endurance", "general_fitness", "mobility", "sport_performance", "rehab_return"]),
    sport: z.string().optional(),
    limitations: z.array(z.string()).default([]).describe('Injuries / conditions, e.g. ["left knee ACL repair 2024", "lower back pain"].'),
    preferences: z.string().max(500).optional(),
  }),
  schedule: z.object({
    days_per_week: z.number().int().min(1).max(7),
    session_minutes: z.number().int().min(15).max(180),
  }),
  equipment: z.union([z.enum(Object.keys(EQUIPMENT_PRESETS) as [string, ...string[]]), z.array(z.string()).min(1)]).default("full_gym"),
  weeks: z.number().int().min(1).max(16).default(4),
  readiness_score: z.number().min(0).max(100).optional().describe("From /recovery-readiness. Under 50 makes week 1 lighter."),
});

const Exercise = z.object({
  name: z.string(),
  sets: z.number(),
  reps: z.string().describe('e.g. "8-10", "30s", "5/side"'),
  rest_sec: z.number(),
  rpe: z.number().optional(),
  tempo: z.string().optional(),
  notes: z.string().optional(),
  substitution: z.string().optional().describe("Alternative if equipment is busy or movement is uncomfortable."),
});

const Output = z.object({
  program_name: z.string(),
  summary: z.string(),
  split: z.string().describe('e.g. "Upper / Lower x2"'),
  week_template: z.array(
    z.object({
      day: z.number(),
      name: z.string(),
      duration_min: z.number(),
      warmup: z.array(z.string()),
      exercises: z.array(Exercise),
      cooldown: z.array(z.string()),
    }),
  ),
  progression: z.array(z.object({ week: z.number(), focus: z.string(), changes: z.string() })),
  deload_guidance: z.string(),
  limitations_handling: z.array(z.object({ limitation: z.string(), adjustments: z.string() })),
  safety_notes: z.array(z.string()),
});

const SYSTEM = `You are a certified strength & conditioning coach (NSCA-CSCS level) building programs for a fitness app.
Rules:
- Only use the listed equipment.
- Respect every limitation: avoid aggravating movements, give a safer substitution, and add a note to clear new or severe pain with a clinician.
- Fit each session inside session_minutes including warm-up and cool-down.
- Beginners: simple compound patterns, RPE 6-7, no max testing. Advanced: may use RPE 8-9 and intensity techniques.
- Balance push/pull/hinge/squat/carry/core across the week.
- Progression must be concrete (sets, reps, load or RPE changes per week). Include a deload when weeks >= 5.
- Never give medical diagnoses.`;

export default defineEndpoint({
  slug: "workout-program",
  title: "AI Workout Program Generator",
  summary: "Personalised, injury-aware training program (week template + progression) for any goal, schedule and equipment.",
  category: "ai",
  usesAI: true,
  zeePalmServices: ["AI Agent (Coaches)", "AI Coach Assistant", "Coaching Platform Setup", "Gym Platform Setup", "Coach Launch"],
  input: Input,
  output: Output,
  disclaimer: "AI-generated training guidance. Have a qualified coach review it, and see a clinician before training with an injury or medical condition.",
  exampleInput: {
    client: { age: 34, sex: "female", experience: "intermediate", goal: "hypertrophy", limitations: ["mild lower back pain when deadlifting"], preferences: "Loves dumbbell work, hates burpees" },
    schedule: { days_per_week: 4, session_minutes: 60 },
    equipment: "full_gym",
    weeks: 6,
  },
  async run(input, { ai }) {
    const equipment = typeof input.equipment === "string" ? EQUIPMENT_PRESETS[input.equipment] : input.equipment;
    const lowReadiness = input.readiness_score !== undefined && input.readiness_score < 50;
    return ai.generate({
      system: SYSTEM,
      prompt: `Build a ${input.weeks}-week program.
<input>
${JSON.stringify({ ...input, equipment }, null, 2)}
</input>
${lowReadiness ? "Readiness is low today: make week 1 a lighter introductory week." : ""}
Return exactly ${input.schedule.days_per_week} sessions in week_template and ${input.weeks} entries in progression.`,
      schema: Output,
    });
  },
  exampleOutput: {
    program_name: "6-Week Back-Friendly Hypertrophy",
    summary: "Upper/lower split, 4 days a week. Deadlift is swapped for back-friendly hinges, and volume builds to week 5 before a deload in week 6.",
    split: "Upper / Lower x2",
    week_template: [
      {
        day: 1,
        name: "Lower A (quad focus)",
        duration_min: 60,
        warmup: ["5 min bike", "Bodyweight squats 2x10", "Glute bridges 2x12", "Bird dogs 2x6/side"],
        exercises: [
          { name: "Goblet squat", sets: 4, reps: "8-10", rest_sec: 120, rpe: 7, tempo: "3-1-1-0", substitution: "Leg press" },
          { name: "Dumbbell Romanian deadlift", sets: 3, reps: "10-12", rest_sec: 90, rpe: 7, notes: "Neutral spine, stop at mid-shin", substitution: "45° back extension" },
          { name: "Bulgarian split squat", sets: 3, reps: "10/side", rest_sec: 75, rpe: 8, substitution: "Reverse lunge" },
          { name: "Leg extension", sets: 3, reps: "12-15", rest_sec: 60, rpe: 8 },
          { name: "Dead bug", sets: 3, reps: "8/side", rest_sec: 45 },
        ],
        cooldown: ["Hip flexor stretch 45s/side", "Child's pose 60s"],
      },
      {
        day: 2,
        name: "Upper A (push focus)",
        duration_min: 60,
        warmup: ["Band pull-aparts 2x15", "Push-ups 2x8"],
        exercises: [
          { name: "Dumbbell bench press", sets: 4, reps: "8-10", rest_sec: 120, rpe: 7 },
          { name: "Chest-supported row", sets: 4, reps: "10-12", rest_sec: 90, rpe: 7, notes: "Chest support unloads the lower back" },
          { name: "Seated dumbbell shoulder press", sets: 3, reps: "10-12", rest_sec: 90, rpe: 8 },
          { name: "Lat pulldown", sets: 3, reps: "10-12", rest_sec: 75, rpe: 8 },
          { name: "Cable lateral raise", sets: 3, reps: "15", rest_sec: 45, rpe: 8 },
        ],
        cooldown: ["Doorway pec stretch 45s", "Thread the needle 5/side"],
      },
      {
        day: 4,
        name: "Lower B (glute/hamstring focus)",
        duration_min: 60,
        warmup: ["5 min incline walk", "Banded lateral walks 2x10/side"],
        exercises: [
          { name: "Barbell hip thrust", sets: 4, reps: "8-10", rest_sec: 120, rpe: 8 },
          { name: "Leg press (feet high)", sets: 3, reps: "10-12", rest_sec: 90, rpe: 8 },
          { name: "Seated leg curl", sets: 3, reps: "12", rest_sec: 60, rpe: 8 },
          { name: "Cable pull-through", sets: 3, reps: "12-15", rest_sec: 60, rpe: 7 },
          { name: "Side plank", sets: 3, reps: "30s/side", rest_sec: 45 },
        ],
        cooldown: ["Figure-4 stretch 45s/side"],
      },
      {
        day: 5,
        name: "Upper B (pull focus)",
        duration_min: 60,
        warmup: ["Scap pull-ups 2x8", "Band face pulls 2x15"],
        exercises: [
          { name: "Assisted pull-up", sets: 4, reps: "6-8", rest_sec: 120, rpe: 8 },
          { name: "Incline dumbbell press", sets: 3, reps: "10-12", rest_sec: 90, rpe: 8 },
          { name: "Single-arm cable row", sets: 3, reps: "12/side", rest_sec: 60, rpe: 8 },
          { name: "Dumbbell curl + triceps pushdown superset", sets: 3, reps: "12 + 12", rest_sec: 60, rpe: 8 },
        ],
        cooldown: ["Lat stretch 45s/side"],
      },
    ],
    progression: [
      { week: 1, focus: "Technique and baseline", changes: "Use the listed sets at RPE 7. Log weights." },
      { week: 2, focus: "Volume", changes: "+1 set on the first two exercises of each day." },
      { week: 3, focus: "Load", changes: "Add 2.5-5% load where the top of the rep range was hit." },
      { week: 4, focus: "Volume", changes: "+1 set on accessories. RPE 8." },
      { week: 5, focus: "Peak", changes: "Push the main lifts to RPE 8-9 and keep the volume." },
      { week: 6, focus: "Deload", changes: "Halve the sets, keep the load, RPE 6." },
    ],
    deload_guidance: "Deload in week 6, or earlier if readiness is under 50 for 3+ days or joint pain increases.",
    limitations_handling: [
      { limitation: "mild lower back pain when deadlifting", adjustments: "Barbell deadlift replaced with DB RDL, hip thrust and pull-through. Rows are chest-supported. Core anti-extension work is added." },
    ],
    safety_notes: ["Stop any exercise that causes sharp or radiating pain.", "See a clinician if back pain persists beyond 2 weeks or spreads to the legs."],
  },
});
