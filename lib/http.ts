import { z } from "zod";
import { CustomSchemaResult, createAIClient } from "./ai";
import { ApiError } from "./errors";
import { pickFields, zodToJsonSchema } from "./json-schema";
import { RequestOptionsSchema, type AnyEndpoint, type EndpointContext } from "./endpoint";

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": process.env.CORS_ORIGIN ?? "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-api-key, x-ai-provider, x-ai-key, x-ai-model",
    "access-control-expose-headers": "x-request-id",
  };
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders(), ...extra },
  });
}

function errorResponse(err: ApiError, requestId: string): Response {
  return json({ ok: false, error: { code: err.code, message: err.message, details: err.details }, meta: { request_id: requestId } }, err.status, {
    "x-request-id": requestId,
  });
}

function zodIssues(error: z.ZodError, prefix = "") {
  return error.issues.map((i) => ({ path: [prefix, ...i.path.map(String)].filter(Boolean).join("."), message: i.message }));
}

function checkAccess(req: Request) {
  const keys = (process.env.API_ACCESS_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (!keys.length) return;
  const sent = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!sent || !keys.includes(sent)) throw new ApiError(401, "unauthorized", "Missing or invalid x-api-key header.");
}

export async function handlePost(endpoint: AnyEndpoint, req: Request): Promise<Response> {
  const requestId = crypto.randomUUID();
  const started = Date.now();
  try {
    checkAccess(req);
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new ApiError(413, "payload_too_large", "Request body must be 8 MB or smaller.");

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiError(400, "invalid_json", "Request body must be a JSON object.");

    const { options: rawOptions, ...rawInput } = body as Record<string, unknown>;
    const options = RequestOptionsSchema.safeParse(rawOptions ?? {});
    if (!options.success) throw new ApiError(422, "validation_error", "Invalid `options`.", zodIssues(options.error, "options"));
    const input = endpoint.input.safeParse(rawInput);
    if (!input.success) throw new ApiError(422, "validation_error", "Request body failed validation.", zodIssues(input.error));

    const ctx: EndpointContext = {
      options: options.data,
      now: options.data.now ? new Date(options.data.now) : new Date(),
      meta: {},
      ai: createAIClient(req.headers, options.data, endpoint.exampleOutput),
    };

    let data: unknown;
    let customSchema = false;
    try {
      data = await endpoint.run(input.data, ctx);
    } catch (err) {
      if (!(err instanceof CustomSchemaResult)) throw err;
      data = err.data;
      customSchema = true;
    }

    if (!customSchema) {
      const checked = endpoint.output.safeParse(data);
      if (!checked.success) throw new ApiError(500, "output_invalid", "Endpoint produced data that doesn't match its output schema.", zodIssues(checked.error));
      data = checked.data;
    }
    if (options.data.fields?.length) data = pickFields(data, options.data.fields);

    const ai = ctx.ai.used();
    return json(
      {
        ok: true,
        data,
        meta: {
          endpoint: endpoint.slug,
          version: "v1",
          request_id: requestId,
          latency_ms: Date.now() - started,
          ...(ai ? { ai } : {}),
          ...(customSchema ? { custom_schema: true } : {}),
          ...ctx.meta,
          ...(endpoint.disclaimer ? { disclaimer: endpoint.disclaimer } : {}),
        },
      },
      200,
      { "x-request-id": requestId },
    );
  } catch (err) {
    if (err instanceof ApiError) return errorResponse(err, requestId);
    console.error(`[${endpoint.slug}] ${requestId}`, err instanceof Error ? err.message : err);
    return errorResponse(new ApiError(500, "internal_error", "Something went wrong."), requestId);
  }
}

export function describe(endpoint: AnyEndpoint, baseUrl = "") {
  return {
    slug: endpoint.slug,
    title: endpoint.title,
    summary: endpoint.summary,
    category: endpoint.category,
    uses_ai: endpoint.usesAI,
    zee_palm_services: endpoint.zeePalmServices,
    method: "POST",
    url: `${baseUrl}/api/v1/${endpoint.slug}`,
    input_schema: zodToJsonSchema(endpoint.input, "input"),
    output_schema: zodToJsonSchema(endpoint.output),
    options_schema: zodToJsonSchema(RequestOptionsSchema, "input"),
    example_request: endpoint.exampleInput,
    ...(endpoint.disclaimer ? { disclaimer: endpoint.disclaimer } : {}),
  };
}
