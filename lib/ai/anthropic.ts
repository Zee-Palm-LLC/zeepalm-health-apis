import Anthropic from "@anthropic-ai/sdk";
import { betaJSONSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { ApiError } from "../errors";
import type { ProviderRequest } from "./index";

const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);
type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export async function anthropicGenerate(req: ProviderRequest): Promise<unknown> {
  const client = new Anthropic({ apiKey: req.apiKey, maxRetries: 2 });

  const content: BetaContentBlockParam[] = req.images.map((img) =>
    "url" in img
      ? { type: "image", source: { type: "url", url: img.url } }
      : { type: "image", source: { type: "base64", media_type: img.media_type as "image/png", data: img.base64 } },
  );
  content.push({ type: "text", text: req.prompt });

  const useFallbacks = FALLBACK_MODELS.has(req.model);
  const effort = (process.env.AI_EFFORT as Effort | undefined) ?? "medium";

  try {
    const msg = await client.beta.messages.parse({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content }],
      output_config: {
        format: betaJSONSchemaOutputFormat(req.schema as { type: "object" }),
        ...(req.model.includes("haiku") ? {} : { effort }),
      },
      ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    });

    if (msg.stop_reason === "refusal") {
      throw new ApiError(422, "ai_refused", "The model declined this request.", msg.stop_details ?? undefined);
    }
    if (msg.stop_reason === "max_tokens") {
      throw new ApiError(502, "ai_truncated", "The model ran out of output tokens. Ask for a smaller result (fewer days, sessions, etc.).");
    }
    if (msg.parsed_output == null) throw new ApiError(502, "ai_output_invalid", "The model returned no parseable JSON.");
    return msg.parsed_output;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new ApiError(401, "ai_auth_failed", "Anthropic rejected the API key.");
    if (err instanceof Anthropic.RateLimitError) throw new ApiError(429, "ai_rate_limited", "Anthropic rate limit reached. Retry shortly.");
    if (err instanceof Anthropic.BadRequestError) throw new ApiError(400, "ai_bad_request", err.message);
    if (err instanceof Anthropic.APIError) throw new ApiError(502, "ai_provider_error", err.message);
    throw err;
  }
}
