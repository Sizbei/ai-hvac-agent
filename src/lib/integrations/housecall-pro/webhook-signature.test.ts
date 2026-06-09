import { describe, it, expect } from "vitest";
import {
  computeWebhookSignature,
  verifyWebhookSignature,
  HCP_SIGNATURE_HEADER,
} from "./webhook-signature";

const SECRET = "whsec_test_abc123";
const BODY = JSON.stringify({ id: "evt_1", event: "job.completed" });

describe("webhook signature", () => {
  it("computes a stable hex HMAC-SHA256 digest", () => {
    const sig = computeWebhookSignature(BODY, SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic for the same body + secret.
    expect(computeWebhookSignature(BODY, SECRET)).toBe(sig);
  });

  it("accepts a VALID signature", () => {
    const sig = computeWebhookSignature(BODY, SECRET);
    expect(verifyWebhookSignature(BODY, sig, SECRET)).toBe(true);
  });

  it("rejects a signature made with a DIFFERENT secret", () => {
    const sig = computeWebhookSignature(BODY, "wrong-secret");
    expect(verifyWebhookSignature(BODY, sig, SECRET)).toBe(false);
  });

  it("rejects when the body was tampered with after signing", () => {
    const sig = computeWebhookSignature(BODY, SECRET);
    const tampered = JSON.stringify({ id: "evt_1", event: "job.canceled" });
    expect(verifyWebhookSignature(tampered, sig, SECRET)).toBe(false);
  });

  it("fails closed on a missing/blank signature header", () => {
    expect(verifyWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, "", SECRET)).toBe(false);
  });

  it("fails closed on an empty secret", () => {
    const sig = computeWebhookSignature(BODY, SECRET);
    expect(verifyWebhookSignature(BODY, sig, "")).toBe(false);
  });

  it("rejects a wrong-length (truncated) signature without throwing", () => {
    const sig = computeWebhookSignature(BODY, SECRET).slice(0, 10);
    expect(verifyWebhookSignature(BODY, sig, SECRET)).toBe(false);
  });

  it("exposes the documented HCP header name", () => {
    expect(HCP_SIGNATURE_HEADER).toBe("x-housecallpro-signature");
  });
});
