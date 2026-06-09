/**
 * Signed tokens for the public /api/voice/tts route.
 *
 * The TTS route is hit by Twilio's media servers (not by our own code), so it
 * can't carry a Twilio webhook signature. To stop it becoming an open
 * ElevenLabs proxy — where anyone could burn our synthesis quota on arbitrary
 * text — the voice routes embed the exact text to speak in a URL together with
 * an HMAC over that text + an expiry. The TTS route only synthesizes text whose
 * signature we can reproduce, so it will only ever speak phrases this app
 * generated, and only for a short window.
 *
 * The signing key is derived from ENCRYPTION_KEY with a domain label (same
 * pattern as the blind index) so it never overlaps the AES or blind-index keys.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const SIGNING_DOMAIN = "hvac-tts-token-v1";

/** Tokens are valid for two minutes — long enough for Twilio to fetch, short
 * enough that a leaked URL can't be replayed for long. */
export const TTS_TOKEN_TTL_MS = 2 * 60 * 1000;

function getSigningKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string (32 bytes)",
    );
  }
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(SIGNING_DOMAIN)
    .digest();
}

function sign(text: string, expiresAt: number): string {
  return createHmac("sha256", getSigningKey())
    .update(String(expiresAt))
    .update("\0")
    .update(text)
    .digest("hex");
}

export interface SignedTtsToken {
  readonly text: string;
  readonly expiresAt: number;
  readonly sig: string;
}

/**
 * Build a signed token for `text`. `now` is injectable for tests; production
 * callers pass Date.now().
 */
export function createTtsToken(text: string, now: number): SignedTtsToken {
  const expiresAt = now + TTS_TOKEN_TTL_MS;
  return { text, expiresAt, sig: sign(text, expiresAt) };
}

/**
 * Constant-time comparison of two SHA-256 hex digests. Both sides are decoded
 * from hex to raw 32-byte buffers first: a malformed/short candidate `sig`
 * still produces a 32-byte buffer (hex decoding stops at the first bad nibble),
 * so the lengths always match and `timingSafeEqual` never throws — and there's
 * no early length-based branch to leak a timing/length oracle.
 */
function safeEqualHex(expected: string, candidate: string): boolean {
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(candidate, "hex");
  if (a.length !== b.length) return false; // expected is always 32B; guards a truncated candidate
  return timingSafeEqual(a, b);
}

/**
 * Verify a token's signature and expiry. Returns the text to synthesize when
 * valid, or null otherwise. Fails closed on any malformed input. `now` is
 * injectable for tests.
 */
export function verifyTtsToken(
  token: Partial<SignedTtsToken>,
  now: number,
): string | null {
  const { text, expiresAt, sig } = token;
  if (typeof text !== "string" || text.length === 0) return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;
  if (typeof sig !== "string" || sig.length === 0) return null;
  if (now > expiresAt) return null;

  const expected = sign(text, expiresAt);
  return safeEqualHex(expected, sig) ? text : null;
}
