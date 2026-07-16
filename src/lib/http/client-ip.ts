import { NextRequest } from "next/server";

/**
 * Trusted client IP for rate-limiting / audit — spoof-resistant.
 *
 * `x-forwarded-for` is fully client-controllable (an attacker rotates it to open
 * a fresh rate-limit bucket per request). Prefer `x-real-ip`: on Vercel the
 * platform sets this to the actual TCP client and a client-supplied value cannot
 * override it — so it can't be rotated to bypass per-IP limits. Fall back to the
 * leftmost XFF entry only for local dev / non-Vercel proxies. Capped to 45 chars
 * (longest IPv6 textual form); "unknown" when both are absent.
 *
 * Single source of truth for client-IP parsing — import this, never read the
 * headers directly.
 */
export function clientIp(request: NextRequest): string {
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp.slice(0, 45);
  const xff = request.headers.get("x-forwarded-for");
  return xff?.split(",")[0]?.trim().slice(0, 45) || "unknown";
}
