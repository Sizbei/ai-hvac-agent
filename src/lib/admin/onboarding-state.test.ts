import { describe, it, expect } from "vitest";
import { parseOnboardingState, LEGACY_ISO } from "./onboarding-state";

describe("parseOnboardingState", () => {
  it("folds legacy dismissed + embedViewed", () => {
    const s = parseOnboardingState({ dismissed: true, embedViewed: true });
    expect(s.dismissedAt).toBe(LEGACY_ISO);
    expect(s.flags.embedCopied).toBe(true);
    expect(s.firstCompleted).toEqual({});
  });

  it("keeps a real dismissedAt over the legacy fold", () => {
    const s = parseOnboardingState({
      dismissed: true,
      dismissedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(s.dismissedAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("dismissed:false yields no dismissedAt", () => {
    const s = parseOnboardingState({ dismissed: false });
    expect(s.dismissedAt).toBeUndefined();
    expect("dismissedAt" in s).toBe(false);
  });

  it("drops only a malformed firstCompleted", () => {
    const s = parseOnboardingState({
      firstCompleted: [1, 2],
      completedSeenAt: "2026-11-02T00:00:00.000Z",
      flags: { embedCopied: true },
    });
    expect(s.firstCompleted).toEqual({});
    expect(s.completedSeenAt).toBe("2026-11-02T00:00:00.000Z");
    expect(s.flags.embedCopied).toBe(true);
  });

  it("drops invalid dates and unknown step ids", () => {
    const s = parseOnboardingState({
      dismissedAt: "not a date",
      firstCompleted: { brand: "2026-11-01T00:00:00.000Z", bogus: "2026-11-01T00:00:00.000Z", pricebook: "x" },
    });
    expect(s.dismissedAt).toBeUndefined();
    expect(s.firstCompleted).toEqual({ brand: "2026-11-01T00:00:00.000Z" });
  });

  it.each([null, "str", 5, [], undefined])("empty state for %j", (raw) => {
    expect(parseOnboardingState(raw)).toEqual({ firstCompleted: {}, flags: {} });
  });

  it("round-trips a valid v2 state", () => {
    const v2 = {
      dismissedAt: "2026-11-01T00:00:00.000Z",
      completedSeenAt: "2026-11-02T00:00:00.000Z",
      firstCompleted: { phone_hours: "2026-11-01T01:00:00.000Z", tech_sign_in: "2026-11-01T02:00:00.000Z" },
      flags: { embedCopied: true, techSignedInAt: "2026-11-01T02:00:00.000Z" },
    };
    expect(parseOnboardingState(v2)).toEqual(v2);
  });
});
