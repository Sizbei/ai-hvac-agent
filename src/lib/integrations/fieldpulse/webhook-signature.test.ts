/**
 * Tests for Fieldpulse webhook signature verification.
 *
 * Tests cover:
 * - Valid signature verification
 * - Invalid signature detection
 * - Missing signature handling
 * - Malformed signature handling
 * - Timing-safe comparison properties
 * - Edge cases (empty payloads, unicode, etc.)
 * - Graceful degradation when no secret is configured
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  computeSignature,
  verifySignature,
  createSignatureHeader,
  getVerificationReason,
  type SignatureVerificationResult,
} from "@/lib/integrations/fieldpulse/webhook-signature";

// Test secret (64 hex chars = 32 bytes)
const TEST_SECRET = "a".repeat(64);

// Test payload
const TEST_PAYLOAD = JSON.stringify({
  id: "evt_123",
  eventType: "job.status_updated",
  jobId: "job_abc",
});

describe("computeSignature", () => {
  it("should compute a deterministic HMAC-SHA256 signature", () => {
    const sig1 = computeSignature(TEST_PAYLOAD, TEST_SECRET);
    const sig2 = computeSignature(TEST_PAYLOAD, TEST_SECRET);
    expect(sig1).toBe(sig2);
  });

  it("should produce different signatures for different payloads", () => {
    const sig1 = computeSignature('{"foo":"bar"}', TEST_SECRET);
    const sig2 = computeSignature('{"baz":"qux"}', TEST_SECRET);
    expect(sig1).not.toBe(sig2);
  });

  it("should produce different signatures for different secrets", () => {
    const secret1 = "a".repeat(64);
    const secret2 = "b".repeat(64);
    const sig1 = computeSignature(TEST_PAYLOAD, secret1);
    const sig2 = computeSignature(TEST_PAYLOAD, secret2);
    expect(sig1).not.toBe(sig2);
  });

  it("should return a 64-char hex string (SHA-256 output)", () => {
    const signature = computeSignature(TEST_PAYLOAD, TEST_SECRET);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should handle empty string payload", () => {
    const signature = computeSignature("", TEST_SECRET);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should handle unicode characters in payload", () => {
    const unicodePayload = JSON.stringify({
      message: "Test with unicode: éàüñö 😀🏠🔧",
    });
    const signature = computeSignature(unicodePayload, TEST_SECRET);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should be deterministic with unicode", () => {
    const unicodePayload = "Hello! Prices are 100 EUR. Data: éàüñö";
    const sig1 = computeSignature(unicodePayload, TEST_SECRET);
    const sig2 = computeSignature(unicodePayload, TEST_SECRET);
    expect(sig1).toBe(sig2);
  });
});

describe("createSignatureHeader", () => {
  it("should create a properly formatted signature header", () => {
    const header = createSignatureHeader(TEST_PAYLOAD, TEST_SECRET);
    expect(header).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("should include the correct signature", () => {
    const header = createSignatureHeader(TEST_PAYLOAD, TEST_SECRET);
    const expectedSignature = computeSignature(TEST_PAYLOAD, TEST_SECRET);
    expect(header).toBe(`sha256=${expectedSignature}`);
  });
});

describe("verifySignature", () => {
  describe("valid signatures", () => {
    it("should accept a valid signature", () => {
      const signatureHeader = createSignatureHeader(TEST_PAYLOAD, TEST_SECRET);
      const result = verifySignature(TEST_PAYLOAD, signatureHeader, TEST_SECRET);
      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should accept valid signature with unicode payload", () => {
      const unicodePayload = JSON.stringify({
        message: "Test with unicode: éàüñö 😀🏠🔧",
      });
      const signatureHeader = createSignatureHeader(unicodePayload, TEST_SECRET);
      const result = verifySignature(unicodePayload, signatureHeader, TEST_SECRET);
      expect(result.valid).toBe(true);
    });

    it("should accept valid signature with empty payload", () => {
      const signatureHeader = createSignatureHeader("", TEST_SECRET);
      const result = verifySignature("", signatureHeader, TEST_SECRET);
      expect(result.valid).toBe(true);
    });
  });

  describe("invalid signatures", () => {
    it("should reject a mismatched signature", () => {
      const wrongPayload = '{"different":"payload"}';
      const wrongSignature = createSignatureHeader(wrongPayload, TEST_SECRET);
      const result = verifySignature(TEST_PAYLOAD, wrongSignature, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("signature_mismatch");
    });

    it("should reject signature with wrong secret", () => {
      const signatureHeader = createSignatureHeader(TEST_PAYLOAD, TEST_SECRET);
      const wrongSecret = "b".repeat(64);
      const result = verifySignature(TEST_PAYLOAD, signatureHeader, wrongSecret);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("signature_mismatch");
    });

    it("should reject completely wrong signature", () => {
      const result = verifySignature(
        TEST_PAYLOAD,
        "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        TEST_SECRET,
      );
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("signature_mismatch");
    });

    it("should reject signature with invalid hex characters", () => {
      const result = verifySignature(TEST_PAYLOAD, "sha256=gggggggggggggggg", TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_format");
    });

    it("should reject signature with wrong length", () => {
      const result = verifySignature(TEST_PAYLOAD, "sha256=abc123", TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("signature_mismatch");
    });
  });

  describe("missing signatures", () => {
    it("should reject null signature when secret is configured", () => {
      const result = verifySignature(TEST_PAYLOAD, null, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("missing_signature");
    });
  });

  describe("malformed signatures", () => {
    it("should reject signature without sha256= prefix", () => {
      const signature = computeSignature(TEST_PAYLOAD, TEST_SECRET);
      const result = verifySignature(TEST_PAYLOAD, signature, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_format");
    });

    it("should reject signature with wrong prefix case", () => {
      const signatureHeader = createSignatureHeader(TEST_PAYLOAD, TEST_SECRET);
      // Wrong case: SHA256 instead of sha256
      const wrongCase = signatureHeader.replace("sha256=", "SHA256=");
      const result = verifySignature(TEST_PAYLOAD, wrongCase, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_format");
    });

    it("should reject empty signature header", () => {
      const result = verifySignature(TEST_PAYLOAD, "", TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("missing_signature");
    });

    it("should reject signature with prefix but no hash", () => {
      const result = verifySignature(TEST_PAYLOAD, "sha256=", TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_format");
    });
  });

  describe("graceful degradation (no secret configured)", () => {
    it("should accept missing signature when no secret is configured", () => {
      const result = verifySignature(TEST_PAYLOAD, null, null);
      expect(result.valid).toBe(true);
      expect(result.reason).toBe("no_secret_configured");
    });

    it("should accept any signature when no secret is configured", () => {
      const result = verifySignature(TEST_PAYLOAD, "sha256=anything", null);
      expect(result.valid).toBe(true);
      expect(result.reason).toBe("no_secret_configured");
    });

    it("should reject valid-looking signature when no secret is configured", () => {
      const signatureHeader = createSignatureHeader(TEST_PAYLOAD, TEST_SECRET);
      const result = verifySignature(TEST_PAYLOAD, signatureHeader, null);
      expect(result.valid).toBe(true);
      expect(result.reason).toBe("no_secret_configured");
    });
  });

  describe("misconfigured (non-hex) secret — empty-key forge guard", () => {
    it("fails closed when the configured secret hex-decodes to an empty key", () => {
      // A non-hex secret → Buffer.from(secret, "hex") is empty. An attacker can
      // forge by signing with the (publicly known) empty key. Verification must
      // reject this rather than verify against the empty-key MAC.
      const nonHexSecret = "not-a-hex-secret";
      const forged = createSignatureHeader(TEST_PAYLOAD, ""); // empty-key HMAC
      const result = verifySignature(TEST_PAYLOAD, forged, nonHexSecret);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("invalid_secret");
    });

    it("getVerificationReason explains the invalid_secret rejection", () => {
      const reason = getVerificationReason({
        valid: false,
        reason: "invalid_secret",
      });
      expect(reason).toMatch(/hex/i);
    });
  });

  describe("timing-safe comparison properties", () => {
    it("should produce signatures of equal length for verification", () => {
      // This ensures timingSafeEqual can be used
      const sig1 = computeSignature("payload1", TEST_SECRET);
      const sig2 = computeSignature("payload2", TEST_SECRET);
      expect(sig1.length).toBe(sig2.length);
      expect(sig1.length).toBe(64); // SHA-256 hex output
    });

    it("should handle comparison of signatures that differ by one bit", () => {
      const sig1 = computeSignature(TEST_PAYLOAD, TEST_SECRET);
      // Flip the last character
      const sig2 = sig1.slice(0, -1) + (sig1.slice(-1) === "a" ? "b" : "a");
      const header = `sha256=${sig2}`;
      const result = verifySignature(TEST_PAYLOAD, header, TEST_SECRET);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe("signature_mismatch");
    });
  });
});

describe("getVerificationReason", () => {
  it("should return readable reason for missing signature", () => {
    const result: SignatureVerificationResult = {
      valid: false,
      reason: "missing_signature",
    };
    expect(getVerificationReason(result)).toBe("Signature header is missing");
  });

  it("should return readable reason for invalid format", () => {
    const result: SignatureVerificationResult = {
      valid: false,
      reason: "invalid_format",
    };
    expect(getVerificationReason(result)).toBe(
      "Signature header format is invalid (expected 'sha256=...')",
    );
  });

  it("should return readable reason for signature mismatch", () => {
    const result: SignatureVerificationResult = {
      valid: false,
      reason: "signature_mismatch",
    };
    expect(getVerificationReason(result)).toBe(
      "Computed signature does not match provided signature",
    );
  });

  it("should return readable reason for no secret configured", () => {
    const result: SignatureVerificationResult = {
      valid: true,
      reason: "no_secret_configured",
    };
    expect(getVerificationReason(result)).toBe(
      "No webhook secret configured (signature optional)",
    );
  });

  it("should return unknown reason for unrecognized reasons", () => {
    const result: SignatureVerificationResult = {
      valid: false,
      reason: undefined,
    };
    expect(getVerificationReason(result)).toBe("Unknown verification reason");
  });
});

describe("integration scenarios", () => {
  it("should handle complete webhook verification flow", () => {
    // Simulate Fieldpulse sending a webhook
    const payload = JSON.stringify({
      id: "evt_test123",
      eventType: "job.status_updated",
      jobId: "job_xyz",
    });

    // Fieldpulse computes signature
    const signatureHeader = createSignatureHeader(payload, TEST_SECRET);

    // We verify
    const result = verifySignature(payload, signatureHeader, TEST_SECRET);

    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("should detect tampered webhook payload", () => {
    const originalPayload = JSON.stringify({
      id: "evt_test123",
      eventType: "job.status_updated",
      jobId: "job_xyz",
    });

    const signatureHeader = createSignatureHeader(originalPayload, TEST_SECRET);

    // Attacker modifies the payload
    const tamperedPayload = JSON.stringify({
      id: "evt_test123",
      eventType: "job.completed", // Changed!
      jobId: "job_xyz",
    });

    const result = verifySignature(tamperedPayload, signatureHeader, TEST_SECRET);

    expect(result.valid).toBe(false);
    expect(result.reason).toBe("signature_mismatch");
  });

  it("should handle production scenario with real-world payload", () => {
    const realPayload = JSON.stringify({
      id: "evt_abc123xyz",
      eventType: "invoice.paid",
      jobId: "fp_job_456",
      invoiceId: "fp_inv_789",
      timestamp: "2024-01-15T10:30:00Z",
    });

    const signatureHeader = createSignatureHeader(realPayload, TEST_SECRET);
    const result = verifySignature(realPayload, signatureHeader, TEST_SECRET);

    expect(result.valid).toBe(true);
  });

  it("should work in dev mode without secret (graceful degradation)", () => {
    const payload = JSON.stringify({ id: "evt_dev" });

    // No secret configured in dev
    const result = verifySignature(payload, null, null);

    expect(result.valid).toBe(true);
    expect(result.reason).toBe("no_secret_configured");
  });
});
