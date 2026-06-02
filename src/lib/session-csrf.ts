/**
 * CSRF guard for the customer-facing session POST endpoints
 * (/api/session/confirm, /feedback, /escalate).
 *
 * WHY THIS EXISTS: the session cookie (hvac_session_token) is SameSite=None so
 * it can travel inside the cross-site <iframe> the chat runs in. That same
 * relaxation means the cookie is also attached to a FORGED cross-site request
 * (a <form> auto-submit or a no-cors fetch) — a classic CSRF vector, since
 * these endpoints act purely on the ambient cookie with no CSRF token.
 *
 * THE DEFENSE: an Origin check. The legitimate caller is ALWAYS same-origin —
 * the /embed iframe (and the standalone /chat page) are served from the app's
 * own origin and call /api with relative URLs, so their request Origin equals
 * the app's own origin. No legitimate POST to these endpoints is cross-origin.
 *
 * Design notes (see the architect review that shaped this):
 *  - Same-origin is anchored on the REQUEST'S OWN origin (request.nextUrl.origin),
 *    NOT a single env var. Anchoring on NEXT_PUBLIC_APP_URL alone would 403 every
 *    action on any deployment host that isn't exactly that value (Vercel
 *    preview / *.vercel.app / a custom domain). NEXT_PUBLIC_APP_URL is accepted
 *    as an ADDITIONAL trusted origin, not the sole authority.
 *  - A modern browser sends `Origin` on every fetch AND form POST, same-origin
 *    included. So an ABSENT Origin on these POSTs is never a legitimate browser
 *    request → we DENY it (closes the Origin-stripping bypass).
 *  - We deliberately do NOT consult the org's widget allowedOrigins here: no
 *    legitimate cross-origin caller exists for these endpoints, so including it
 *    would only widen the accepted set and add a hot-path DB read.
 *
 * TRUST BOUNDARY (important if you leave Vercel): `request.nextUrl.origin` is
 * derived from the Host header when Next's `trustHostHeader` is on (auto-enabled
 * on Vercel builds). On Vercel this is safe — the edge network validates the
 * Host against registered deployment domains before the request reaches the
 * function, so an attacker can't spoof `selfOrigin`. If you self-host, put a
 * reverse proxy in front that validates the Host header against an allowlist
 * (or pin a fixed hostname with trustHostHeader off); otherwise an attacker who
 * can reach the backend directly could set Host=evil.com and self-approve.
 */
import type { NextRequest } from "next/server";

/** Normalize to a comparable origin: trim, lowercase, strip trailing slash. */
function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/\/+$/, "");
  return v.length > 0 ? v : null;
}

/** The app's canonical origin from NEXT_PUBLIC_APP_URL, if configured. */
function configuredAppOrigin(): string | null {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (!raw) return null;
  try {
    return normalizeOrigin(new URL(raw).origin);
  } catch {
    return null;
  }
}

/**
 * Returns true if the request's Origin is the app's own origin (the only
 * legitimate source for these endpoints), false otherwise. An absent Origin
 * returns false — it is never a legitimate browser POST here.
 */
export function isSameOriginRequest(request: NextRequest): boolean {
  const origin = normalizeOrigin(request.headers.get("origin"));
  if (!origin) return false;

  // Same-origin: the Origin matches the host this request actually came in on.
  // Robust across every deployment domain (preview, *.vercel.app, custom).
  const selfOrigin = normalizeOrigin(request.nextUrl.origin);
  if (selfOrigin && origin === selfOrigin) return true;

  // Also accept the configured canonical app origin, in case it differs from
  // the current host but is still trusted (e.g. behind a proxy/CDN rewrite).
  const appOrigin = configuredAppOrigin();
  if (appOrigin && origin === appOrigin) return true;

  return false;
}

/**
 * Defense-in-depth for endpoints that parse a JSON body: require the request to
 * declare `application/json`. A cross-site <form> can only send the CORS
 * "simple" content types (text/plain, urlencoded, multipart) — which skip the
 * preflight — so rejecting anything but application/json kills that no-preflight
 * forgery path. (Next's request.json() does NOT enforce Content-Type itself.)
 */
export function hasJsonContentType(request: NextRequest): boolean {
  const ct = request.headers.get("content-type");
  if (!ct) return false;
  // Tolerate parameters like "application/json; charset=utf-8".
  return ct.split(";")[0].trim().toLowerCase() === "application/json";
}
