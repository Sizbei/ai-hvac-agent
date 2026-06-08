/**
 * Twilio request signature validation.
 *
 * Twilio signs each webhook with X-Twilio-Signature: an HMAC-SHA1 (base64) over
 * the full request URL followed by every POST parameter, sorted by key, with
 * key and value concatenated. Validating it proves the request genuinely came
 * from Twilio (using the shared auth token) and wasn't forged or replayed with
 * altered params. See: twilio.com/docs/usage/security#validating-requests
 *
 * Pure / dependency-free (Node crypto only) so it unit-tests without the SDK,
 * and fails CLOSED: a missing auth token or absent signature is never valid.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Compute the expected signature for a URL + param set. */
export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac("sha1", authToken).update(data, "utf8").digest("base64");
}

/** Constant-time comparison of two base64 signatures. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on length mismatch — guard so a wrong-length forged
  // signature returns false rather than throwing.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function validateTwilioSignature(params: {
  readonly authToken: string | undefined | null;
  readonly signature: string | undefined | null;
  readonly url: string;
  readonly params: Record<string, string>;
}): boolean {
  const { authToken, signature, url } = params;
  // Fail closed: no token configured or no signature header → reject.
  if (!authToken || !signature) return false;
  const expected = computeTwilioSignature(authToken, url, params.params);
  return safeEqual(expected, signature);
}
