import { isOriginAllowed } from "./origin";

/**
 * CORS for the PUBLIC widget endpoints (called cross-origin from a contractor's
 * site). The hard rule from the security review: reflect the request Origin
 * ONLY when it's on the org's allowlist — NEVER `Access-Control-Allow-Origin: *`
 * (that would let any site use the widget and defeat the allowlist).
 *
 * When the allowlist is EMPTY, the org hasn't locked down its domains, so we
 * reflect any origin (the publishable key alone gates access) — this matches
 * the resolver's "empty allowlist = open" behavior. Once the org adds even one
 * entry, only matching origins get CORS.
 */

const BASE_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-HVAC-Widget-Key",
  "Access-Control-Max-Age": "86400",
  Vary: "Origin",
};

/**
 * Compute the CORS headers to attach to a response for `origin`, given the org's
 * `allowedOrigins`. Returns headers WITHOUT an Allow-Origin when the origin
 * isn't permitted (the browser then blocks the cross-origin read).
 */
export function corsHeaders(
  origin: string | null | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const headers = { ...BASE_HEADERS };
  if (!origin) return headers;

  // Empty allowlist → open (key-gated). Non-empty → must match.
  const permitted =
    allowedOrigins.length === 0 || isOriginAllowed(origin, allowedOrigins);
  if (permitted) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/** Merge CORS headers into an existing Headers/Response-init headers object. */
export function withCors(
  init: Record<string, string>,
  origin: string | null | undefined,
  allowedOrigins: readonly string[],
): Record<string, string> {
  return { ...init, ...corsHeaders(origin, allowedOrigins) };
}
