import { describe, it, expect } from "vitest";
import {
  computeBillingSignature,
  verifyBillingSignature,
} from "./webhook-signature";

const SECRET = "test-secret";
const BODY = JSON.stringify({ id: "evt_1", type: "subscription.updated" });

describe("verifyBillingSignature", () => {
  it("accepts a correct signature", () => {
    const sig = computeBillingSignature(BODY, SECRET);
    expect(verifyBillingSignature(BODY, sig, SECRET)).toBe(true);
  });

  it("rejects a tampered body (fail closed)", () => {
    const sig = computeBillingSignature(BODY, SECRET);
    expect(verifyBillingSignature(BODY + "x", sig, SECRET)).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const sig = computeBillingSignature(BODY, "other");
    expect(verifyBillingSignature(BODY, sig, SECRET)).toBe(false);
  });

  it("rejects a missing/blank signature header", () => {
    expect(verifyBillingSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyBillingSignature(BODY, "", SECRET)).toBe(false);
  });

  it("rejects when the secret is empty", () => {
    const sig = computeBillingSignature(BODY, SECRET);
    expect(verifyBillingSignature(BODY, sig, "")).toBe(false);
  });
});
