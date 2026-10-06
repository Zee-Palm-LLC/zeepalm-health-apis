import { z } from "zod";

type Schema = Record<string, unknown>;

/** Zod -> plain JSON Schema (draft 2020-12), without the `$schema` marker. */
export function zodToJsonSchema(schema: z.ZodType, io: "input" | "output" = "output"): Schema {
  const out = z.toJSONSchema(schema, { target: "draft-2020-12", io, unrepresentable: "any" }) as Schema;
  delete out.$schema;
  return out;
}

const STRIP_FOR_STRICT = new Set([
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems",
  "minProperties", "maxProperties", "default", "examples", "$schema", "$id",
]);

/**
 * Make a schema acceptable to OpenAI strict mode: every object closes
 * (`additionalProperties: false`), every property is required, and optional
 * properties become `anyOf: [T, null]`. Nulls are removed again by `dropNulls`.
 */
export function toStrictAllRequired(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toStrictAllRequired);
  if (!node || typeof node !== "object") return node;
  const src = node as Schema;
  const out: Schema = {};
  for (const [k, v] of Object.entries(src)) {
    if (STRIP_FOR_STRICT.has(k)) continue;
    out[k] = toStrictAllRequired(v);
  }
  if (out.type === "object" || out.properties) {
    const props = (out.properties ?? {}) as Record<string, Schema>;
    const required = new Set((src.required as string[] | undefined) ?? []);
    for (const key of Object.keys(props)) {
      if (!required.has(key)) props[key] = { anyOf: [props[key], { type: "null" }] };
    }
    out.properties = props;
    out.required = Object.keys(props);
    out.additionalProperties = false;
  }
  return out;
}

/** Remove `null` values from objects (models fill skipped optional fields with null). */
export function dropNulls<T>(value: T): T {
  if (Array.isArray(value)) return value.map(dropNulls) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = dropNulls(v);
    return out as T;
  }
  return value;
}

/** Keep only the requested dot-paths of an object, e.g. ["score", "components.hrv"]. */
export function pickFields(data: unknown, fields: string[]): unknown {
  if (!data || typeof data !== "object") return data;
  const out: Record<string, unknown> = {};
  for (const path of fields) {
    const parts = path.split(".");
    let src: unknown = data;
    for (const p of parts) src = src && typeof src === "object" ? (src as Record<string, unknown>)[p] : undefined;
    if (src === undefined) continue;
    let dst = out;
    parts.slice(0, -1).forEach((p) => {
      dst[p] = (dst[p] as Record<string, unknown>) ?? {};
      dst = dst[p] as Record<string, unknown>;
    });
    dst[parts[parts.length - 1]] = src;
  }
  return out;
}
