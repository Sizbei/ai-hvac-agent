import { describe, it, expect } from "vitest";
import {
  decideAfterHoursDisclosure,
  type AfterHoursDecision,
} from "./after-hours-chat";
import { DEFAULT_AFTER_HOURS_CONFIG } from "@/lib/admin/after-hours";

// DEFAULT config: America/New_York, after-hours 6pm–8am + weekends.
// Pick fixed instants so the pure helper never reads the wall clock.
//
// 2026-06-09 is a Tuesday (a weekday) — so the weekend rule doesn't fire and
// the only thing that flips after-hours is the hour-of-day in Eastern time.
const TUE_8PM_ET = new Date("2026-06-09T20:00:00-04:00"); // after-hours (>=18)
const TUE_2PM_ET = new Date("2026-06-09T14:00:00-04:00"); // business hours

function decide(
  clock: Date,
  urgency: Parameters<typeof decideAfterHoursDisclosure>[0]["urgency"],
  customerSignal: Parameters<
    typeof decideAfterHoursDisclosure
  >[0]["customerSignal"] = "unknown",
): AfterHoursDecision {
  return decideAfterHoursDisclosure({
    clock,
    config: DEFAULT_AFTER_HOURS_CONFIG,
    urgency,
    customerSignal,
  });
}

describe("decideAfterHoursDisclosure", () => {
  describe("during business hours", () => {
    it("returns 'none' — no charge talk, no urgency gate", () => {
      const d = decide(TUE_2PM_ET, null);
      expect(d.kind).toBe("none");
      expect(d.copy).toBe("");
      expect(d.afterHours).toBe(false);
    });

    it("returns 'none' even for an emergency in business hours", () => {
      const d = decide(TUE_2PM_ET, "emergency");
      expect(d.kind).toBe("none");
    });
  });

  describe("after hours + urgent", () => {
    it("emergency urgency discloses the charge with NO dollar figure", () => {
      const d = decide(TUE_8PM_ET, "emergency");
      expect(d.kind).toBe("disclose_charge");
      expect(d.afterHours).toBe(true);
      expect(d.copy.length).toBeGreaterThan(0);
      // The disclosure must never quote a number/currency.
      expect(d.copy).not.toMatch(/\$/);
      expect(d.copy).not.toMatch(/\d/);
      expect(d.copy.toLowerCase()).toContain("after-hours");
    });

    it("high urgency discloses the charge (no ask needed)", () => {
      const d = decide(TUE_8PM_ET, "high");
      expect(d.kind).toBe("disclose_charge");
      expect(d.copy).not.toMatch(/\d/);
    });

    it("customer confirming 'yes' to the urgency ask discloses the charge", () => {
      // Urgency not yet classified, but the customer answered the ask.
      const d = decide(TUE_8PM_ET, null, "urgent");
      expect(d.kind).toBe("disclose_charge");
      expect(d.copy).not.toMatch(/\d/);
    });
  });

  describe("after hours + not urgent", () => {
    it("offers a next-business-day visit at no extra charge", () => {
      const d = decide(TUE_8PM_ET, "low", "not_urgent");
      expect(d.kind).toBe("offer_next_day");
      expect(d.afterHours).toBe(true);
      expect(d.copy.length).toBeGreaterThan(0);
      expect(d.copy.toLowerCase()).toContain("next business day");
      expect(d.copy.toLowerCase()).toContain("no after-hours charge");
    });

    it("medium urgency with no customer signal asks whether it's urgent", () => {
      const d = decide(TUE_8PM_ET, "medium");
      expect(d.kind).toBe("ask_urgency");
      expect(d.copy.length).toBeGreaterThan(0);
      expect(d.copy.toLowerCase()).toContain("urgent");
    });

    it("unknown urgency with no signal asks whether it's urgent", () => {
      const d = decide(TUE_8PM_ET, null);
      expect(d.kind).toBe("ask_urgency");
      expect(d.copy.toLowerCase()).toContain("urgent");
    });
  });

  describe("disabled config never threatens a charge", () => {
    it("returns 'none' when the org disables after-hours pricing", () => {
      const d = decideAfterHoursDisclosure({
        clock: TUE_8PM_ET,
        config: { ...DEFAULT_AFTER_HOURS_CONFIG, enabled: false },
        urgency: "emergency",
        customerSignal: "unknown",
      });
      expect(d.kind).toBe("none");
    });
  });
});
