import { z } from "zod";
import type { AIClient } from "./ai";

export type EndpointCategory = "wearables" | "fitness" | "nutrition" | "retention" | "mental-health" | "clinic-ops" | "ai";

export interface EndpointContext {
  ai: AIClient;
  options: RequestOptions;
  now: Date;
  meta: Record<string, unknown>;
}

export interface EndpointDef<I extends z.ZodType, O extends z.ZodType> {
  slug: string;
  title: string;
  summary: string;
  category: EndpointCategory;
  usesAI: boolean;
  zeePalmServices: string[];
  input: I;
  output: O;
  exampleInput: z.input<I> & { options?: z.input<typeof RequestOptionsSchema> };
  exampleOutput?: unknown;
  run: (input: z.output<I>, ctx: EndpointContext) => Promise<z.output<O>> | z.output<O>;
  disclaimer?: string;
}

export type AnyEndpoint = EndpointDef<any, any>;

export function defineEndpoint<I extends z.ZodType, O extends z.ZodType>(def: EndpointDef<I, O>): EndpointDef<I, O> {
  return def;
}

export const RequestOptionsSchema = z
  .object({
    fields: z
      .array(z.string())
      .optional()
      .describe('Return only these fields of `data`. Dot paths are supported, e.g. ["score", "components.hrv"].'),
    language: z.string().optional().describe("AI endpoints: write all human-readable text in this language (e.g. \"Urdu\", \"es\")."),
    instructions: z
      .string()
      .max(4000)
      .optional()
      .describe("AI endpoints: extra instructions appended to the system prompt (tone, brand voice, house rules)."),
    response_schema: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("AI endpoints: your own JSON Schema (type: object). The model returns exactly this shape instead of the default output."),
    model: z.string().optional().describe("AI endpoints: override the model for this request."),
    now: z.iso.datetime({ offset: true }).optional().describe("Override the current time (ISO 8601). Useful for tests and backfills."),
  })
  .strict();

export type RequestOptions = z.infer<typeof RequestOptionsSchema>;
