import { ApiError } from "../errors";
import { toStrictAllRequired } from "../json-schema";
import type { ProviderRequest } from "./index";

export async function openaiGenerate(req: ProviderRequest): Promise<unknown> {
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const userContent = [
    { type: "text", text: req.prompt },
    ...req.images.map((img) => ({
      type: "image_url",
      image_url: { url: "url" in img ? img.url : `data:${img.media_type};base64,${img.base64}` },
    })),
  ];

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${req.apiKey}` },
    body: JSON.stringify({
      model: req.model,
      max_completion_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: userContent },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "response", strict: true, schema: toStrictAllRequired(req.schema) },
      },
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    choices?: { message?: { content?: string; refusal?: string }; finish_reason?: string }[];
  };
  if (!res.ok) {
    const status = res.status === 401 ? 401 : res.status === 429 ? 429 : res.status === 400 ? 400 : 502;
    throw new ApiError(status, "ai_provider_error", body.error?.message ?? `OpenAI returned HTTP ${res.status}.`);
  }
  const choice = body.choices?.[0];
  if (choice?.message?.refusal) throw new ApiError(422, "ai_refused", choice.message.refusal);
  if (choice?.finish_reason === "length") throw new ApiError(502, "ai_truncated", "The model ran out of output tokens.");
  try {
    return JSON.parse(choice?.message?.content ?? "");
  } catch {
    throw new ApiError(502, "ai_output_invalid", "The model returned invalid JSON.");
  }
}
