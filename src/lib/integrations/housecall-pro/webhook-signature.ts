/**
 * Housecall Pro webhook SIGNATURE verification. (Stage 5.)
 *
 * HCP signs each webhook with HMAC-SHA256 over the RAW request body, keyed by
 * the per-account webhook signing secret, and sends the hex digest in the
 * `x-housecallpro-signature` header (verified against docs.housecallpro.com).
 * The endpoint MUST verify this before trusting the payload — an attacker who
 * could POST a forged "job.completed" would otherwise drive our state machine.
 *
 * Pure + dependency-free (node:crypto only): given the raw body, the header
 * value, and the secret it returns a boolean. Comparison is TIMING-SAFE
 * (constant-time) so a byte-by-byte early-exit can't leak the expected digest.
 * Never logs the secret or the signature.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The header HCP carries the webhook signature in. */
export const HCP_SIGNATURE_HEADER = "x-housecallpro-signature";

/** Compute the expected hex HMAC-SHA256 signature for a raw body + secret. */
export function computeWebhookSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Verify an inbound HCP webhook signature. Returns false (never throws) when the
 * header is absent/blank, the secret is empty, or the hex strings differ — so a
 * missing or malformed signature fails CLOSED. The compare is constant-time over
 * equal-length buffers; unequal lengths short-circuit to false (the lengths
 * themselves aren't secret — both are fixed 64-hex SHA-256 digests).
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || signature.length === 0 || secret.length === 0) {
    return false;
  }
  const expected = computeWebhookSignature(rawBody, secret);
  // Compare as bytes. Different lengths can't be timingSafeEqual'd, and a length
  // mismatch already means "not equal", so bail early in that case.
  if (signature.length !== expected.length) {
    return false;
  }
  try {
    return timingSafeEqual(
      Buffer.from(signature, "utf8"),
      Buffer.from(expected, "utf8"),
    );
  } catch {
    return false;
  }
}
