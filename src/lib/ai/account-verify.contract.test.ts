import { describe, it, expect } from "vitest";
import { requiresVerify } from "./account-verify";
import { LEGACY_ACCOUNT_INTENT_TOOL } from "./account-dispatch";

/**
 * A7/A13 contract lock.
 *
 * `requiresVerify` returns false for any intent id absent from
 * INTENT_SENSITIVITY — an UNSAFE default. That is tolerable only while the
 * table is provably a superset of every id that can reach a real account
 * tool. This test is what makes it provable: add a capability mapping without
 * a sensitivity entry and this fails, instead of silently disclosing another
 * customer's data off a self-reported phone number.
 */
describe("account verify sensitivity contract", () => {
  it("gates every intent that maps to a real account capability", () => {
    const ungated = Object.keys(LEGACY_ACCOUNT_INTENT_TOOL).filter(
      (intentId) => !requiresVerify(intentId),
    );
    expect(ungated).toEqual([]);
  });

  it("still lets non-account intents through without a verify step", () => {
    for (const intentId of ["pricing-general", "hours-of-operation", "faq-filters"]) {
      expect(requiresVerify(intentId)).toBe(false);
    }
    expect(requiresVerify(null)).toBe(false);
  });
});
