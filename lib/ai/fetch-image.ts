import { ApiError } from "../errors";
import type { ImageInput } from "./index";

const MAX_BYTES = 5 * 1024 * 1024;

export async function toBase64Image(img: ImageInput): Promise<{ base64: string; media_type: string }> {
  if (!("url" in img)) return img;
  const url = new URL(img.url);
  if (url.protocol !== "https:") throw new ApiError(400, "invalid_image_url", "image_url must use https.");
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new ApiError(400, "image_fetch_failed", `Couldn't download image_url (HTTP ${res.status}).`);
  const type = res.headers.get("content-type")?.split(";")[0] ?? "";
  if (!type.startsWith("image/")) throw new ApiError(400, "image_fetch_failed", "image_url didn't return an image.");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) throw new ApiError(413, "image_too_large", "Images must be 5 MB or smaller.");
  return { base64: buf.toString("base64"), media_type: type };
}
