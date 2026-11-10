/**
 * The "View as" preview cookie (spec P7).
 *
 * Value: `base64url(JSON claims) + "." + base64url(HMAC-SHA256 signature)`.
 * The signing key is DERIVED from AUTH_SECRET (plan ruling 3):
 * `HMAC-SHA256(key = AUTH_SECRET, message = "hvac_preview/v1")`, so it is
 * separate from the session-JWT key and needs no new env var.
 *
 * Runs in the proxy on every request carrying the cookie, so it uses Web
 * Crypto only (no Node APIs, no DB).
 */

export const PREVIEW_COOKIE = "hvac_preview";
export const PREVIEW_MAX_AGE_S = 7200;

const KEY_LABEL = "hvac_preview/v1";

export interface PreviewClaims {
  readonly adminUserId: string;
  readonly targetUserId: string;
  /** Expiry, unix seconds. */
  readonly exp: number;
}

export interface PreviewCookieOptions {
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: "strict";
  readonly path: "/";
  readonly maxAge: number;
}

export function previewCookieOptions(): PreviewCookieOptions {
  return { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: PREVIEW_MAX_AGE_S };
}

/** Anything with a Next `cookies.set(name, value, options)` (response cookies, cookies()). */
interface CookieSetter {
  set(name: string, value: string, options: PreviewCookieOptions & { expires: Date }): unknown;
}

/**
 * Expire the preview cookie with the same attributes it was set with. Both
 * Max-Age=0 and an epoch Expires: when a route also touches `cookies()`, Next
 * re-serializes the response cookies and drops `maxAge: 0`.
 */
export function clearPreviewCookie(cookies: CookieSetter): void {
  cookies.set(PREVIEW_COOKIE, "", { ...previewCookieOptions(), maxAge: 0, expires: new Date(0) });
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url decode; null for anything outside the alphabet. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length === 0 || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// One derived key per AUTH_SECRET; the secret is fixed per deployment.
let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function deriveKey(authSecret: string): Promise<CryptoKey> {
  const master = await crypto.subtle.importKey(
    "raw",
    encoder.encode(authSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", master, encoder.encode(KEY_LABEL));
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function previewKey(authSecret: string): Promise<CryptoKey> {
  if (cachedKey?.secret === authSecret) return cachedKey.key;
  const key = await deriveKey(authSecret);
  cachedKey = { secret: authSecret, key };
  return key;
}

export async function signPreviewCookie(c: PreviewClaims, authSecret: string): Promise<string> {
  if (!authSecret) throw new Error("AUTH_SECRET is required to sign the preview cookie");
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({ adminUserId: c.adminUserId, targetUserId: c.targetUserId, exp: c.exp }),
    ),
  );
  const sig = await crypto.subtle.sign("HMAC", await previewKey(authSecret), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(sig))}`;
}

function parseClaims(bytes: Uint8Array): PreviewClaims | null {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { adminUserId, targetUserId, exp } = raw as Record<string, unknown>;
  if (typeof adminUserId !== "string" || adminUserId.length === 0) return null;
  if (typeof targetUserId !== "string" || targetUserId.length === 0) return null;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return null;
  return { adminUserId, targetUserId, exp };
}

/**
 * The claims when `value` carries a valid signature under the derived key and
 * has not expired; otherwise null. Never throws.
 */
export async function verifyPreviewCookie(
  value: string,
  authSecret: string,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<PreviewClaims | null> {
  try {
    if (!authSecret) return null;
    const parts = value.split(".");
    if (parts.length !== 2) return null;
    const [payload, sigText] = parts;
    const sig = fromBase64Url(sigText);
    const body = fromBase64Url(payload);
    if (!sig || !body) return null;
    const ok = await crypto.subtle.verify(
      "HMAC",
      await previewKey(authSecret),
      sig,
      encoder.encode(payload),
    );
    if (!ok) return null;
    const claims = parseClaims(body);
    if (!claims) return null;
    // Expired, or further out than any cookie this app ever issues.
    if (claims.exp <= nowS || claims.exp - nowS > PREVIEW_MAX_AGE_S) return null;
    return claims;
  } catch {
    return null;
  }
}
