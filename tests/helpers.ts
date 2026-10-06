import { endpointBySlug } from "@/endpoints";
import { handlePost } from "@/lib/http";

export async function call(slug: string, body: unknown, headers: Record<string, string> = {}) {
  const endpoint = endpointBySlug.get(slug)!;
  const res = await handlePost(
    endpoint,
    new Request(`http://localhost/api/v1/${slug}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }),
  );
  return { status: res.status, body: (await res.json()) as { ok: boolean; data: any; error?: any; meta: any } };
}
