/**
 * SaaS-billing webhook SIGNATURE verification (Stage 10).
 *
 * The webhook is signed with HMAC-SHA256 over the RAW request body, keyed by
 * SAAS_BILLING_WEBHOOK_SECRET, with the hex digest in the
 * `x-saas-billing-signature` header. The endpoint MUST verify this before
 * trusting the payload — an attacker who could POST a forged
 * "subscription.deleted" would otherwise suspend a tenant. Pure + dependency
 * free (node:crypto only). Comparison is TIMING-SAFE. Never logs the secret or
 * the signature. (Mirrors the HCP webhook-signature helper; a real Stripe
 * adapter would swap this for Stripe's own `t=,v1=` scheme.)
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** The header the SaaS-billing webhook carries its signature in. */
export const SAAS_BILLING_SIGNATURE_HEADER = "x-saas-billing-signature";

/** Compute the expected hex HMAC-SHA256 signature for a raw body + secret. */
export function computeBillingSignature(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Verify an inbound SaaS-billing webhook signature. Returns false (never throws)
 * when the header is absent/blank, the secret is empty, or the digests differ —
 * so a missing or malformed signature FAILS CLOSED. Constant-time compare over
 * equal-length buffers; a length mismatch short-circuits to false.
 */
export function verifyBillingSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || signature.length === 0 || secret.length === 0) {
    return false;
  }
  const expected = computeBillingSignature(rawBody, secret);
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
