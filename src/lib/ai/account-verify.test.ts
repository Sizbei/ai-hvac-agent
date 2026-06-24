import { describe, it, expect } from "vitest";
import {
  requiresVerify,
  extractZipsFromAddress,
  checkZipMatch,
  preserveVerifyKey,
  advanceVerify,
  MAX_VERIFY_ATTEMPTS,
  type VerifyState,
} from "./account-verify";
import { buildExtraction } from "./chat-slots";

describe("requiresVerify", () => {
  it("gates financial intents only", () => {
    expect(requiresVerify("account-data-balance")).toBe(true);
    expect(requiresVerify("account-data-membership-status")).toBe(true);
    expect(requiresVerify("account-data-next-visit")).toBe(false);
    expect(requiresVerify("account-data-appointment-status")).toBe(false);
    expect(requiresVerify(null)).toBe(false);
  });
});

describe("extractZipsFromAddress", () => {
  it("pulls a 5-digit ZIP from a US address", () => {
    expect(extractZipsFromAddress("212 E Unaka Ave, Johnson City, TN 37601")).toEqual(["37601"]);
  });
  it("returns [] when no 5-digit ZIP is present (non-US / missing)", () => {
    expect(extractZipsFromAddress("12 King St, Toronto, ON K1A 0B1")).toEqual([]);
  });
});

describe("checkZipMatch", () => {
  it("matches DTMF digits against any on-file ZIP", () => {
    expect(checkZipMatch("37601", ["37601", "37615"])).toBe(true);
  });
  it("matches a spoken ZIP with 'oh' for zero", () => {
    expect(checkZipMatch("three seven six oh one", ["37601"])).toBe(true);
  });
  it("rejects a mismatch", () => {
    expect(checkZipMatch("00000", ["37601"])).toBe(false);
  });
  // FINDING 3 REGRESSION: a 10-digit run that happens to prefix-match a ZIP must NOT pass.
  // Only exactly 5 digits should match (not >=5 then slice).
  it("REGRESSION F3: rejects a 10-digit DTMF run even if the first 5 digits match the ZIP", () => {
    // "3760112345" → slice(0,5) = "37601" which matches, but the input has 10 digits.
    // This must be FALSE — the caller keyed 10 digits, not 5.
    expect(checkZipMatch("3760112345", ["37601"])).toBe(false);
  });
  it("REGRESSION F3b: rejects a 6-digit run that prefix-matches a ZIP", () => {
    expect(checkZipMatch("376019", ["37601"])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// metadata.verify survival through the voice gather-route async extraction.
//
// Documented lockout-wipe bug class: voiceReply owns a top-level `verify` key in
// session metadata, but buildExtraction does NOT round-trip it. The gather
// route's background extraction rebuilds metadata via buildExtraction, so it
// MUST splice `verify` back (preserveVerifyKey) — otherwise every non-financial
// turn resets the ZIP-verify lockout and MAX_VERIFY_ATTEMPTS.
// ---------------------------------------------------------------------------
describe("preserveVerifyKey — verify survives the gather-route rebuild", () => {
  it("ROOT CAUSE: buildExtraction drops a top-level verify key", () => {
    // A verify key smuggled into slot extras must NOT survive buildExtraction —
    // this is exactly why the route has to re-splice it.
    const rebuilt = buildExtraction(
      { issueType: "cooling_not_working", urgency: "high" },
      "AC down",
    ) as Record<string, unknown>;
    expect(rebuilt.verify).toBeUndefined();
  });

  it("re-attaches verify from the fresh metadata onto a rebuilt extraction", () => {
    const rebuilt = buildExtraction({ issueType: "cooling_not_working" }, "AC down");
    const fresh = JSON.stringify({
      issueType: "cooling_not_working",
      verify: { status: "failed", attempts: 2 },
    });
    const merged = preserveVerifyKey(rebuilt, fresh) as Record<string, unknown>;
    // The lockout (failed, 2 attempts) survives — not wiped by the rebuild.
    expect(merged.verify).toEqual({ status: "failed", attempts: 2 });
  });

  it("leaves the extraction unchanged when the fresh metadata has no verify key", () => {
    const rebuilt = buildExtraction({ issueType: "cooling_not_working" }, "AC down");
    const merged = preserveVerifyKey(rebuilt, JSON.stringify({ issueType: "cooling_not_working" }));
    expect((merged as Record<string, unknown>).verify).toBeUndefined();
  });

  it("is null/unparseable-safe (no verify, no throw)", () => {
    const rebuilt = buildExtraction({ issueType: "cooling_not_working" }, "AC down");
    expect(() => preserveVerifyKey(rebuilt, null)).not.toThrow();
    expect(() => preserveVerifyKey(rebuilt, "{not json")).not.toThrow();
    expect((preserveVerifyKey(rebuilt, "{not json") as Record<string, unknown>).verify).toBeUndefined();
  });

  it("preserves a pending lockout across a non-financial turn (the real scenario)", () => {
    // Caller failed one ZIP attempt (verify pending, attempts:1), then a
    // non-financial turn triggers background extraction. The lockout must persist.
    const rebuilt = buildExtraction(
      { issueType: "heating_not_working", urgency: "medium" },
      "furnace noise",
    );
    const fresh = JSON.stringify({ verify: { status: "pending", attempts: 1 } });
    const merged = preserveVerifyKey(rebuilt, fresh) as Record<string, unknown>;
    expect(merged.verify).toEqual({ status: "pending", attempts: 1 });
  });
});

describe("advanceVerify (channel-agnostic financial-verify decision)", () => {
  const ONFILE = ["37601", "37615"] as const;

  it("non-financial intent serves immediately and never fabricates a passed state", () => {
    // No state → serve, state stays null (a fabricated "passed" would let a later
    // financial ask skip the ZIP check).
    expect(
      advanceVerify({ intentId: "account-data-next-visit", state: null, zipAnswer: "", onFileZips: [] }),
    ).toEqual({ kind: "serve", verify: null });
    // An existing pending lockout is carried through UNCHANGED, not cleared.
    const pending: VerifyState = { status: "pending", attempts: 1 };
    expect(
      advanceVerify({ intentId: "account-data-next-visit", state: pending, zipAnswer: "", onFileZips: [] }),
    ).toEqual({ kind: "serve", verify: pending });
  });

  it("financial + already passed → serve, state unchanged", () => {
    const passed: VerifyState = { status: "passed", attempts: 1 };
    expect(
      advanceVerify({ intentId: "account-data-balance", state: passed, zipAnswer: "", onFileZips: ONFILE }),
    ).toEqual({ kind: "serve", verify: passed });
  });

  it("financial + already failed → defer, no re-ask", () => {
    const failed: VerifyState = { status: "failed", attempts: 2 };
    expect(
      advanceVerify({ intentId: "account-data-balance", state: failed, zipAnswer: "37601", onFileZips: ONFILE }),
    ).toEqual({ kind: "defer", verify: failed });
  });

  it("financial + no state → first ZIP challenge (pending, attempts 0)", () => {
    expect(
      advanceVerify({ intentId: "account-data-membership-status", state: null, zipAnswer: "", onFileZips: ONFILE }),
    ).toEqual({ kind: "ask", verify: { status: "pending", attempts: 0 } });
  });

  it("financial + pending + correct ZIP → serve, upgraded to passed", () => {
    const pending: VerifyState = { status: "pending", attempts: 0 };
    expect(
      advanceVerify({ intentId: "account-data-balance", state: pending, zipAnswer: "37601", onFileZips: ONFILE }),
    ).toEqual({ kind: "serve", verify: { status: "passed", attempts: 1 } });
  });

  it("financial + pending + wrong ZIP under the limit → re-ask, attempts incremented", () => {
    const pending: VerifyState = { status: "pending", attempts: 0 };
    expect(
      advanceVerify({ intentId: "account-data-balance", state: pending, zipAnswer: "00000", onFileZips: ONFILE }),
    ).toEqual({ kind: "ask", verify: { status: "pending", attempts: 1 } });
  });

  it("financial + pending + wrong ZIP hitting MAX_VERIFY_ATTEMPTS → defer + failed (lockout)", () => {
    const pending: VerifyState = { status: "pending", attempts: MAX_VERIFY_ATTEMPTS - 1 };
    expect(
      advanceVerify({ intentId: "account-data-balance", state: pending, zipAnswer: "00000", onFileZips: ONFILE }),
    ).toEqual({ kind: "defer", verify: { status: "failed", attempts: MAX_VERIFY_ATTEMPTS } });
  });

  it("empty on-file ZIPs never auto-pass (a customer with no address can't be bypassed)", () => {
    const pending: VerifyState = { status: "pending", attempts: 0 };
    // Even a "valid-looking" ZIP can't match an empty on-file set → re-ask, not serve.
    expect(
      advanceVerify({ intentId: "account-data-balance", state: pending, zipAnswer: "37601", onFileZips: [] }),
    ).toEqual({ kind: "ask", verify: { status: "pending", attempts: 1 } });
  });
});
