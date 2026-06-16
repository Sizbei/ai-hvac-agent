/**
 * Fieldpulse Webhook Signature Verification (HMAC-SHA256)
 *
 * This module provides timing-safe signature verification for Fieldpulse webhooks.
 *
 * IMPLEMENTATION NOTES:
 * - Uses HMAC-SHA256 for signature computation
 * - Timing-safe comparison to prevent timing attacks
 * - Fail-closed behavior (rejects if secret is configured but signature is invalid)
 * - Graceful degradation (if no secret configured, signature is optional)
 *
 * EXPECTED SIGNATURE FORMAT:
 * Header: x-fieldpulse-signature
 * Format: sha256=<hex_signature>
 * Example: sha256=abc123def456...
 *
 * USAGE:
 * 1. Set FIELDPULSE_WEBHOOK_SECRET in .env (hex string of shared secret)
 * 2. Fieldpulse signs each webhook payload with HMAC-SHA256
 * 3. We verify the signature before processing
 *
 * SECURITY PROPERTIES:
 * - Timing-safe: Uses crypto.timingSafeEqual() to prevent timing attacks
 * - Fail-closed: If secret is configured, invalid signatures are rejected
 * - Graceful degradation: If no secret is configured, signature is optional (warnings logged)
 * - Idempotent: Verification is deterministic and has no side effects
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Expected signature header format.
 * Fieldpulse sends: "sha256=<hex_signature>"
 */
const SIGNATURE_PREFIX = "sha256=";
const SIGNATURE_HEADER = "x-fieldpulse-signature";
const HASH_ALGORITHM = "sha256";

/**
 * Verification result.
 */
export interface SignatureVerificationResult {
  valid: boolean;
  reason?: "missing_signature" | "invalid_format" | "signature_mismatch" | "no_secret_configured";
}

/**
 * Computes the HMAC-SHA256 signature for a given payload and secret.
 *
 * @param payload - The raw request body (string)
 * @param secret - The webhook secret (hex string)
 * @returns The hex-encoded signature
 */
export function computeSignature(payload: string, secret: string): string {
  // Convert hex secret to Buffer
  const secretBuffer = Buffer.from(secret, "hex");

  // Compute HMAC-SHA256
  const hmac = createHmac(HASH_ALGORITHM, secretBuffer);
  hmac.update(payload, "utf8");
  const digest = hmac.digest();

  // Return hex-encoded signature
  return digest.toString("hex");
}

/**
 * Verifies a webhook signature using timing-safe comparison.
 *
 * @param payload - The raw request body (string)
 * @param signatureHeader - The value of the x-fieldpulse-signature header
 * @param secret - The webhook secret (hex string), or null if not configured
 * @returns Verification result with optional reason for failure
 */
export function verifySignature(
  payload: string,
  signatureHeader: string | null,
  secret: string | null,
): SignatureVerificationResult {
  // Case 1: No secret configured - signature is optional
  if (!secret) {
    return {
      valid: true,
      reason: "no_secret_configured",
    };
  }

  // Case 2: Secret configured but no signature provided - fail closed
  if (!signatureHeader || signatureHeader === "") {
    return {
      valid: false,
      reason: "missing_signature",
    };
  }

  // Case 3: Signature doesn't have the expected prefix
  if (!signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return {
      valid: false,
      reason: "invalid_format",
    };
  }

  // Extract the provided signature
  const providedSignature = signatureHeader.slice(SIGNATURE_PREFIX.length);

  // Compute the expected signature
  const expectedSignature = computeSignature(payload, secret);

  // Case 4: Timing-safe comparison of signatures
  // Validate hex format first
  if (!/^[0-9a-fA-F]*$/.test(providedSignature)) {
    return {
      valid: false,
      reason: "invalid_format",
    };
  }

  // Empty signature after prefix is invalid
  if (providedSignature.length === 0) {
    return {
      valid: false,
      reason: "invalid_format",
    };
  }

  try {
    const providedBuffer = Buffer.from(providedSignature, "hex");
    const expectedBuffer = Buffer.from(expectedSignature, "hex");

    // Timing-safe comparison prevents timing attacks
    if (providedBuffer.length !== expectedBuffer.length) {
      return {
        valid: false,
        reason: "signature_mismatch",
      };
    }

    const isEqual = timingSafeEqual(providedBuffer, expectedBuffer);

    return {
      valid: isEqual,
      reason: isEqual ? undefined : "signature_mismatch",
    };
  } catch {
    // Invalid hex in provided signature (shouldn't happen due to regex check)
    return {
      valid: false,
      reason: "invalid_format",
    };
  }
}

/**
 * Creates a signature header value for testing purposes.
 * This simulates what Fieldpulse would send.
 *
 * @param payload - The raw request body (string)
 * @param secret - The webhook secret (hex string)
 * @returns The signature header value (e.g., "sha256=abc123...")
 */
export function createSignatureHeader(payload: string, secret: string): string {
  const signature = computeSignature(payload, secret);
  return `${SIGNATURE_PREFIX}${signature}`;
}

/** Default max age for a webhook event before it's treated as a replay. */
export const DEFAULT_WEBHOOK_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Decide whether a webhook timestamp is too old (a replay).
 *
 * Conservative by design: an ABSENT or UNPARSEABLE timestamp returns false (do
 * NOT reject) — Fieldpulse's exact envelope is unconfirmed, so we never break a
 * real webhook over a missing/odd timestamp; the idempotency ledger still stops
 * exact duplicates. Only a present, parseable timestamp outside the window is a
 * replay. Accepts epoch seconds, epoch ms, or an ISO string.
 */
export function isReplayTimestamp(
  timestamp: number | string | undefined | null,
  maxAgeMs: number = DEFAULT_WEBHOOK_MAX_AGE_MS,
  now: () => number = Date.now,
): boolean {
  if (timestamp === undefined || timestamp === null || timestamp === "") {
    return false;
  }
  let ms: number;
  if (typeof timestamp === "number") {
    // Heuristic: values below ~1e12 are epoch seconds, not ms.
    ms = timestamp < 1e12 ? timestamp * 1000 : timestamp;
  } else {
    ms = Date.parse(timestamp);
  }
  if (Number.isNaN(ms)) {
    return false;
  }
  return Math.abs(now() - ms) > maxAgeMs;
}

/**
 * Extracts the verification reason for logging purposes.
 * Returns a human-readable description of why verification failed.
 */
export function getVerificationReason(result: SignatureVerificationResult): string {
  switch (result.reason) {
    case "missing_signature":
      return "Signature header is missing";
    case "invalid_format":
      return "Signature header format is invalid (expected 'sha256=...')";
    case "signature_mismatch":
      return "Computed signature does not match provided signature";
    case "no_secret_configured":
      return "No webhook secret configured (signature optional)";
    default:
      return "Unknown verification reason";
  }
}
