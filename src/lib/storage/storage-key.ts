/**
 * Map a public R2 URL (`${R2_PUBLIC_URL}/<key>`) back to its object key, so a
 * stored URL (e.g. a replaced or erased signature) can be deleted. Returns null
 * when the URL is null, the public URL is unset, or the URL is not under it.
 */
export function storageKeyFromPublicUrl(
  url: string | null,
  publicUrl = process.env.R2_PUBLIC_URL,
): string | null {
  if (!url || !publicUrl) return null;
  const prefix = `${publicUrl.replace(/\/+$/, "")}/`;
  if (!url.startsWith(prefix)) return null;
  const key = url.slice(prefix.length);
  return key.length > 0 ? key : null;
}
