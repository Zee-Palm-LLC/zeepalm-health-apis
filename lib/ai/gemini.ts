import { ApiError } from "../errors";
import { toBase64Image } from "./fetch-image";
import type { ProviderRequest } from "./index";

/** Google Gemini generateContent with JSON Schema output. */
export async function geminiGenerate(req: ProviderRequest): Promise<unknown> {
  const images = await Promise.all(req.images.map(toBase64Image));
  const res = await fetch(`${(process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "")}/models/${encodeURIComponent(req.model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": req.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [
        {
          role: "user",
          parts: [...images.map((i) => ({ inlineData: { mimeType: i.media_type, data: i.base64 } })), { text: req.prompt }],
        },
      ],
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        responseMimeType: "application/json",
        responseJsonSchema: req.schema,
      },
    }),
  });

  const body = (await res.json().catch(() => ({}))) as {
    error?: { message?: string };
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  };
  if (!res.ok) {
    const status = res.status === 401 || res.status === 403 ? 401 : res.status === 429 ? 429 : res.status === 400 ? 400 : 502;
    throw new ApiError(status, "ai_provider_error", body.error?.message ?? `Gemini returned HTTP ${res.status}.`);
  }
  const cand = body.candidates?.[0];
  if (cand?.finishReason === "SAFETY") throw new ApiError(422, "ai_refused", "Gemini blocked this request for safety reasons.");
  if (cand?.finishReason === "MAX_TOKENS") throw new ApiError(502, "ai_truncated", "The model ran out of output tokens.");
  const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(502, "ai_output_invalid", "The model returned invalid JSON.");
  }
}
