import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { endpoints } from "@/endpoints";
import { call } from "./helpers";

let server: Server;
let base = "";
const seen: { url: string; headers: Record<string, unknown>; body: any }[] = [];
let reply: (url: string) => unknown = () => ({});

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ url: req.url!, headers: req.headers, body: JSON.parse(raw || "{}") });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply(req.url!)));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
afterEach(() => {
  seen.length = 0;
  vi.unstubAllEnvs();
});

const notes = endpoints.find((e) => e.slug === "session-notes")!;
const sample = notes.exampleOutput;

describe("anthropic adapter", () => {
  it("sends structured-output request with fallbacks and parses JSON", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", base);
    reply = () => ({
      id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: JSON.stringify(sample) }],
      usage: { input_tokens: 10, output_tokens: 10 },
    });
    const { status, body } = await call(notes.slug, { ...(notes.exampleInput as object), options: { language: "Urdu" } }, { "x-ai-provider": "anthropic", "x-ai-key": "sk-test" });
    expect(body.error).toBeUndefined();
    expect(status).toBe(200);
    expect(body.meta.ai).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
    const req = seen[0];
    expect(req.url).toContain("/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-test");
    expect(String(req.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(req.body.fallbacks).toBe("default");
    expect(req.body.output_config.format.type).toBe("json_schema");
    expect(req.body.output_config.effort).toBe("medium");
    expect(req.body.system).toContain("Urdu");
  });

  it("maps refusals to 422", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", base);
    reply = () => ({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "refusal", stop_sequence: null, stop_details: { type: "refusal", category: null, explanation: null }, content: [], usage: { input_tokens: 1, output_tokens: 0 } });
    const { status, body } = await call(notes.slug, notes.exampleInput, { "x-ai-provider": "anthropic", "x-ai-key": "sk-test" });
    expect(status).toBe(422);
    expect(body.error.code).toBe("ai_refused");
  });

  it("returns custom response_schema output as-is", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", base);
    reply = () => ({ id: "m", type: "message", role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn", stop_sequence: null, content: [{ type: "text", text: '{"one_line":"Knee improving","pain":2}' }], usage: { input_tokens: 1, output_tokens: 1 } });
    const schema = { type: "object", properties: { one_line: { type: "string" }, pain: { type: "number" } }, required: ["one_line", "pain"], additionalProperties: false };
    const { body } = await call(notes.slug, { ...(notes.exampleInput as object), options: { response_schema: schema } }, { "x-ai-provider": "anthropic", "x-ai-key": "sk-test" });
    expect(body.data).toEqual({ one_line: "Knee improving", pain: 2 });
    expect(body.meta.custom_schema).toBe(true);
    expect(seen[0].body.output_config.format.schema.properties.one_line).toBeDefined();
  });
});

describe("openai adapter", () => {
  it("sends strict json_schema and strips nulls", async () => {
    vi.stubEnv("OPENAI_BASE_URL", base);
    reply = () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ ...(sample as object), client_recap: null }) } }] });
    const { status, body } = await call(notes.slug, notes.exampleInput, { "x-ai-provider": "openai", "x-ai-key": "sk-o", "x-ai-model": "gpt-test" });
    expect(status).toBe(200);
    expect(body.data.client_recap).toBeUndefined();
    expect(seen[0].body.model).toBe("gpt-test");
    expect(seen[0].body.response_format.json_schema.strict).toBe(true);
    expect(seen[0].headers.authorization).toBe("Bearer sk-o");
  });
});

describe("gemini adapter", () => {
  it("sends responseJsonSchema", async () => {
    vi.stubEnv("GEMINI_BASE_URL", base);
    reply = () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(sample) }] } }] });
    const { status } = await call(notes.slug, notes.exampleInput, { "x-ai-provider": "gemini", "x-ai-key": "g-key" });
    expect(status).toBe(200);
    expect(seen[0].url).toContain("/models/gemini-flash-latest:generateContent");
    expect(seen[0].body.generationConfig.responseJsonSchema.type).toBe("object");
    expect(seen[0].headers["x-goog-api-key"]).toBe("g-key");
  });
});
