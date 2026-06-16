/**
 * Shared Vercel Cron authentication.
 *
 * Cron endpoints authenticate with a Bearer CRON_SECRET. Comparison is
 * timing-safe (constant-time) so a remote attacker can't recover the secret
 * character-by-character from response timing. Fails CLOSED when CRON_SECRET is
 * missing/blank — a misconfigured secret must never collapse to "Bearer ".
 */
import { timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

/** Constant-time string compare; false (not throw) on length mismatch. */
export function timingSafeStrEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a cron request's `Authorization: Bearer <CRON_SECRET>` header.
 * Returns false when the secret is unconfigured (fail closed), the header is
 * absent/malformed, or the token doesn't match (timing-safe).
 */
export function verifyCronAuth(authHeader: string | null): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return false;
  }
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) {
    return false;
  }
  return timingSafeStrEqual(authHeader.slice(BEARER_PREFIX.length), expected);
}
