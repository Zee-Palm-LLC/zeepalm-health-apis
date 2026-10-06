import type { AnyEndpoint } from "@/lib/endpoint";
import wearablesNormalize from "./wearables-normalize";
import recoveryReadiness from "./recovery-readiness";
import nutritionTargets from "./nutrition-targets";
import memberChurnRisk from "./member-churn-risk";
import mentalHealthScreening from "./mental-health-screening";
import workoutProgram from "./workout-program";
import mealPlan from "./meal-plan";
import frontDeskIntake from "./front-desk-intake";
import labelScan from "./label-scan";
import sessionNotes from "./session-notes";

/** Register endpoints here. Remove a line to disable one; add yours with defineEndpoint(). */
export const endpoints: AnyEndpoint[] = [
  wearablesNormalize,
  recoveryReadiness,
  nutritionTargets,
  memberChurnRisk,
  mentalHealthScreening,
  workoutProgram,
  mealPlan,
  frontDeskIntake,
  labelScan,
  sessionNotes,
];

export const endpointBySlug = new Map(endpoints.map((e) => [e.slug, e]));
