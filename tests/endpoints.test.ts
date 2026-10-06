import { afterEach, describe, expect, it, vi } from "vitest";
import { endpoints } from "@/endpoints";
import { call } from "./helpers";

afterEach(() => vi.unstubAllEnvs());

describe("every endpoint's example request succeeds", () => {
  for (const e of endpoints) {
    it(e.slug, async () => {
      const { status, body } = await call(e.slug, e.exampleInput, e.usesAI ? { "x-ai-provider": "mock" } : {});
      expect(body.error).toBeUndefined();
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.meta.endpoint).toBe(e.slug);
    });
  }
});

describe("request handling", () => {
  it("rejects invalid input with field paths", async () => {
    const { status, body } = await call("nutrition-targets", { sex: "female", age: 5, goal: "lose" });
    expect(status).toBe(422);
    expect(body.error.details.map((d: { path: string }) => d.path)).toContain("age");
  });

  it("projects fields with options.fields", async () => {
    const { body } = await call("nutrition-targets", { sex: "male", age: 30, height_cm: 180, weight_kg: 80, goal: "maintain", options: { fields: ["target_kcal", "macros.protein_g"] } });
    expect(body.data).toEqual({ target_kcal: expect.any(Number), macros: { protein_g: expect.any(Number) } });
  });

  it("requires an AI key when no provider is configured", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("AI_PROVIDER", "");
    const e = endpoints.find((x) => x.slug === "workout-program")!;
    const { status, body } = await call(e.slug, e.exampleInput);
    expect(status).toBe(401);
    expect(body.error.code).toBe("ai_key_missing");
  });

  it("enforces API_ACCESS_KEYS when set", async () => {
    vi.stubEnv("API_ACCESS_KEYS", "secret1,secret2");
    const body = { sex: "male", age: 30, height_cm: 180, weight_kg: 80, goal: "maintain" };
    expect((await call("nutrition-targets", body)).status).toBe(401);
    expect((await call("nutrition-targets", body, { "x-api-key": "secret2" })).status).toBe(200);
  });

  it("rejects BYOK headers when ALLOW_BYOK=false", async () => {
    vi.stubEnv("ALLOW_BYOK", "false");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    const e = endpoints.find((x) => x.slug === "session-notes")!;
    const { status } = await call(e.slug, e.exampleInput, { "x-ai-provider": "mock" });
    expect(status).toBe(401);
  });
});
