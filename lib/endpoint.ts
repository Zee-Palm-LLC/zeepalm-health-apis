import { z } from "zod";
import type { AIClient } from "./ai";

/**
 * Every API in this repo is a single `defineEndpoint(...)` call in /endpoints.
 *
 * - `input`  : Zod schema for the request body. Edit it and validation, the
 *              playground and the OpenAPI spec all update automatically.
 * - `output` : Zod schema for `data` in the response. For AI endpoints this is
 *              also the JSON Schema the model is forced to follow.
 * - `run`    : the logic. Deterministic endpoints ignore `ctx.ai`.
 */
export type EndpointCategory = "wearables" | "fitness" | "nutrition" | "retention" | "mental-health" | "clinic-ops" | "ai";

export interface EndpointContext {
  /** Present on every request; throws a helpful error if no provider key is configured. */
  ai: AIClient;
  /** Common request options (see RequestOptionsSchema below). */
  options: RequestOptions;
  /** Request time, overridable via `options.now` for reproducible tests. */
  now: Date;
  /** Extra fields merged into the response `meta` (e.g. safety-guard results). Survives custom response schemas. */
  meta: Record<string, unknown>;
}

export interface EndpointDef<I extends z.ZodType, O extends z.ZodType> {
  slug: string;
  title: string;
  summary: string;
  category: EndpointCategory;
  /** Whether the endpoint calls an LLM (needs a provider key unless `x-ai-provider: mock`). */
  usesAI: boolean;
  /** Zee Palm services this API is a building block for. */
  zeePalmServices: string[];
  input: I;
  output: O;
  /** Example request body shown in the playground and docs. */
  exampleInput: z.input<I> & { options?: z.input<typeof RequestOptionsSchema> };
  /** For AI endpoints: what the model returns when called with `x-ai-provider: mock` (before post-processing). */
  exampleOutput?: unknown;
  run: (input: z.output<I>, ctx: EndpointContext) => Promise<z.output<O>> | z.output<O>;
  /** Shown in `meta.disclaimer` on every response. */
  disclaimer?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
