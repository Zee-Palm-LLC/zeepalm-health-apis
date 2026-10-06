import { endpointBySlug } from "@/endpoints";
import { corsHeaders, describe, handlePost, json } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ slug: string }> };

function notFound(slug: string) {
  return json({ ok: false, error: { code: "not_found", message: `No endpoint "${slug}". GET /api/v1 lists them all.` } }, 404);
}

export async function POST(req: Request, { params }: Params) {
  const { slug } = await params;
  const endpoint = endpointBySlug.get(slug);
  return endpoint ? handlePost(endpoint, req) : notFound(slug);
}

export async function GET(req: Request, { params }: Params) {
  const { slug } = await params;
  const endpoint = endpointBySlug.get(slug);
  return endpoint ? json(describe(endpoint, new URL(req.url).origin)) : notFound(slug);
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
