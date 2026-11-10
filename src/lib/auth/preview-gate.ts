/**
 * Read-only enforcement for "View as" (spec P7), run by `src/proxy.ts`.
 *
 * While a valid preview cookie is bound to the signed-in admin, only GET/HEAD
 * get through (minus GET handlers that write), plus the two ways out: the
 * preview-exit POST and logout. Pure and cheap: one HMAC verify for the
 * cookie, one for the session JWT, no DB.
 */
import { verifyToken } from "./config";
import { verifyPreviewCookie } from "./preview-cookie";

/**
 * GET handlers whose body writes (audit rows, OAuth state, sign-in). `*` is
 * any single path segment. Compared against `normalizePreviewPath` output.
 */
export const PREVIEW_GET_DENY: readonly string[] = [
  "/api/auth/google/start",
  "/api/auth/google/callback",
  "/api/auth/signup/callback",
  "/api/admin/integrations/google/connect",
  "/api/admin/integrations/google/callback",
  "/api/admin/export",
  "/api/admin/accounting/export",
  "/api/platform/organizations/*/export",
];

/** The only non-GET requests allowed while previewing (POST, exact paths). */
const PREVIEW_WRITE_ALLOW: readonly string[] = ["/api/admin/preview/exit", "/api/auth/logout"];

// Enough rounds for any honest path; a path still changing after this is refused.
const MAX_DECODE_ROUNDS = 4;

function decodeFully(pathname: string): string | null {
  let current = pathname;
  for (let i = 0; i < MAX_DECODE_ROUNDS; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  return null;
}

/**
 * A canonical form for deny-list matching: decoded (repeatedly, so `%2565`
 * cannot hide an `e`), backslashes as slashes, dot segments resolved, empty
 * segments and the trailing slash dropped, lowercased. Null when decoding
 * fails; callers treat null as refuse.
 */
export function normalizePreviewPath(pathname: string): string | null {
  const decoded = decodeFully(pathname);
  if (decoded === null) return null;
  const segments: string[] = [];
  for (const segment of decoded.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`.toLowerCase();
}

function matchesPattern(path: string, pattern: string): boolean {
  const a = path.split("/");
  const b = pattern.split("/");
  return a.length === b.length && b.every((seg, i) => seg === "*" || seg === a[i]);
}

/**
 * The exit/logout exceptions match the RAW path exactly (one optional trailing
 * slash), never a decoded form: an encoded spelling could route to a different
 * (dynamic) handler than the one it decodes to.
 */
function isAllowedWrite(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  const raw = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
  return PREVIEW_WRITE_ALLOW.includes(raw);
}

export function previewGate(method: string, pathname: string): "allow" | "refuse" {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") {
    const normalized = normalizePreviewPath(pathname);
    if (normalized === null) return "refuse";
    return PREVIEW_GET_DENY.some((p) => matchesPattern(normalized, p)) ? "refuse" : "allow";
  }
  return isAllowedWrite(m, pathname) ? "allow" : "refuse";
}

export type PreviewProxyDecision =
  | { readonly action: "pass" }
  | { readonly action: "refuse" }
  | { readonly action: "clear" };

/**
 * - no cookie → pass (the request is untouched);
 * - cookie invalid/expired, no valid session, or bound to another admin →
 *   clear (the request proceeds; the response deletes the cookie);
 * - valid and bound → `previewGate` decides pass or refuse.
 *
 * Whether the TARGET is still an active same-org user is the viewer's job
 * (Task 15); a stale target stays read-only (plan ruling 9).
 */
export async function previewProxyDecision(p: {
  method: string;
  pathname: string;
  sessionToken: string | undefined;
  previewCookie: string | undefined;
  authSecret: string;
  nowS?: number;
}): Promise<PreviewProxyDecision> {
  if (p.previewCookie === undefined) return { action: "pass" };
  const claims = await verifyPreviewCookie(p.previewCookie, p.authSecret, p.nowS);
  if (!claims) return { action: "clear" };
  const session = p.sessionToken ? await verifyToken(p.sessionToken) : null;
  if (!session || session.userId !== claims.adminUserId) return { action: "clear" };
  return previewGate(p.method, p.pathname) === "allow" ? { action: "pass" } : { action: "refuse" };
}
