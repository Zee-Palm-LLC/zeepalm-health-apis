import { endpoints } from "@/endpoints";
import { RequestOptionsSchema } from "@/lib/endpoint";
import { json } from "@/lib/http";
import { zodToJsonSchema } from "@/lib/json-schema";

/** OpenAPI 3.1 spec generated from the Zod schemas. Import into Postman, Insomnia or Swagger UI. */
export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const options = zodToJsonSchema(RequestOptionsSchema, "input");
  const envelope = (data: object) => ({
    type: "object",
    properties: { ok: { const: true }, data, meta: { type: "object" } },
    required: ["ok", "data", "meta"],
  });
  const error = {
    description: "Error",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };

  const paths = Object.fromEntries(
    endpoints.map((e) => {
      const input = zodToJsonSchema(e.input, "input") as { properties?: Record<string, unknown> };
      input.properties = { ...input.properties, options };
      return [
        `/api/v1/${e.slug}`,
        {
          post: {
            operationId: e.slug.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()),
            summary: e.title,
            description: `${e.summary}${e.usesAI ? "\n\nUses AI: configure a provider key or send `x-ai-provider: mock`." : ""}${e.disclaimer ? `\n\n${e.disclaimer}` : ""}`,
            tags: [e.category],
            ...(e.usesAI
              ? { parameters: ["x-ai-provider", "x-ai-key", "x-ai-model"].map((name) => ({ name, in: "header", required: false, schema: { type: "string" } })) }
              : {}),
            requestBody: { required: true, content: { "application/json": { schema: input, example: e.exampleInput } } },
            responses: {
              "200": { description: "Success", content: { "application/json": { schema: envelope(zodToJsonSchema(e.output)) } } },
              "401": error,
              "422": error,
              "502": error,
            },
          },
        },
      ];
    }),
  );

  return json({
    openapi: "3.1.0",
    info: {
      title: "Zee Palm Health APIs",
      version: "1.0.0",
      description: "Open-source healthcare, fitness and wellness APIs by Zee Palm Labs.",
      license: { name: "MIT" },
    },
    servers: [{ url: origin }],
    components: {
      securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key" } },
      schemas: {
        Error: {
          type: "object",
          properties: {
            ok: { const: false },
            error: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, details: {} } },
          },
        },
      },
    },
    paths,
  });
}
