import { endpoints } from "@/endpoints";
import { json } from "@/lib/http";

export function GET(req: Request) {
  const origin = new URL(req.url).origin;
  return json({
    name: "Zee Palm Health APIs",
    version: "v1",
    docs: `${origin}/`,
    openapi: `${origin}/api/openapi`,
    endpoints: endpoints.map((e) => ({ slug: e.slug, title: e.title, summary: e.summary, uses_ai: e.usesAI, method: "POST", url: `${origin}/api/v1/${e.slug}` })),
  });
}
