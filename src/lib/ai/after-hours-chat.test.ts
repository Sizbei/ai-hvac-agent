import { describe, it, expect } from "vitest";
import {
  decideAfterHoursDisclosure,
  inferBookingTarget,
  readUrgencySignal,
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
  bookingTarget: Parameters<
    typeof decideAfterHoursDisclosure
  >[0]["bookingTarget"] = "unknown",
): AfterHoursDecision {
  return decideAfterHoursDisclosure({
    clock,
    config: DEFAULT_AFTER_HOURS_CONFIG,
    urgency,
    customerSignal,
    bookingTarget,
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

  describe("booking target gates the charge (Fix 2)", () => {
    it("after-hours + business-hours booking → NO charge, even if urgency is high", () => {
      // A customer chatting at 8pm who wants tomorrow morning is booking
      // business hours. The charge is keyed to when the tech goes out, so a
      // heuristic "high" urgency must NOT override an explicit next-day window.
      const d = decide(TUE_8PM_ET, "high", "unknown", "business_hours");
      expect(d.kind).toBe("offer_next_day");
      expect(d.afterHours).toBe(true);
      // Must affirm no charge and never quote a figure.
      expect(d.copy.toLowerCase()).toContain("no after-hours charge");
      expect(d.copy).not.toMatch(/\d/);
      expect(d.copy).not.toMatch(/\$/);
    });

    it("after-hours + business-hours booking → NO charge even with an emergency classification", () => {
      // Defensive: even an "emergency" label can't manufacture a charge once the
      // customer has said they want a normal-hours slot.
      const d = decide(TUE_8PM_ET, "emergency", "unknown", "business_hours");
      expect(d.kind).toBe("offer_next_day");
      expect(d.copy.toLowerCase()).toContain("no after-hours charge");
    });

    it("after-hours + 'now' booking target discloses the charge", () => {
      // Customer explicitly wants someone tonight/ASAP → the service really is
      // after hours → disclose (no dollar amount).
      const d = decide(TUE_8PM_ET, null, "unknown", "now");
      expect(d.kind).toBe("disclose_charge");
      expect(d.copy).not.toMatch(/\d/);
      expect(d.copy.toLowerCase()).toContain("after-hours");
    });

    it("business hours + business-hours booking is still 'none'", () => {
      const d = decide(TUE_2PM_ET, "high", "unknown", "business_hours");
      expect(d.kind).toBe("none");
    });

    it("omitting bookingTarget preserves legacy behavior (defaults to unknown)", () => {
      // Back-compat: existing callers that don't pass bookingTarget still get
      // the urgency-driven decision.
      const d = decideAfterHoursDisclosure({
        clock: TUE_8PM_ET,
        config: DEFAULT_AFTER_HOURS_CONFIG,
        urgency: "emergency",
        customerSignal: "unknown",
      });
      expect(d.kind).toBe("disclose_charge");
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

describe("inferBookingTarget", () => {
  it("maps 'asap' to now", () => {
    expect(inferBookingTarget("asap", "unknown")).toBe("now");
  });

  it("maps daytime windows to business_hours", () => {
    expect(inferBookingTarget("morning", "unknown")).toBe("business_hours");
    expect(inferBookingTarget("afternoon", "unknown")).toBe("business_hours");
    expect(inferBookingTarget("evening", "unknown")).toBe("business_hours");
  });

  it("a stated business-hours window overrides an urgent signal", () => {
    // The documented behavior: a daytime window beats the urgency heuristic so
    // a caller who wants "tomorrow morning" is never threatened with a charge.
    expect(inferBookingTarget("morning", "urgent")).toBe("business_hours");
  });

  it("falls back to the urgency signal when no window is stated", () => {
    expect(inferBookingTarget(undefined, "not_urgent")).toBe("business_hours");
    expect(inferBookingTarget(undefined, "urgent")).toBe("now");
  });

  it("returns 'unknown' when neither a window nor a clear signal is present", () => {
    expect(inferBookingTarget(undefined, "unknown")).toBe("unknown");
    expect(inferBookingTarget("whenever", "unknown")).toBe("unknown");
  });
});

describe("readUrgencySignal", () => {
  it("returns 'unknown' when we did NOT ask last turn (never over-reads)", () => {
    expect(readUrgencySignal(false, "yes it's an emergency")).toBe("unknown");
    expect(readUrgencySignal(false, "no rush")).toBe("unknown");
  });

  it("reads clear affirmatives as urgent", () => {
    for (const m of ["yes", "yeah", "it's urgent", "ASAP please", "can't wait", "we need someone tonight"]) {
      expect(readUrgencySignal(true, m)).toBe("urgent");
    }
  });

  it("reads clear negatives as not_urgent", () => {
    for (const m of ["no", "nope", "tomorrow is fine", "whenever works", "no rush"]) {
      expect(readUrgencySignal(true, m)).toBe("not_urgent");
    }
  });

  it("stays 'unknown' on an ambiguous reply", () => {
    expect(readUrgencySignal(true, "well it depends")).toBe("unknown");
    expect(readUrgencySignal(true, "the AC is upstairs")).toBe("unknown");
  });

  // KNOWN QUIRK (roadmap follow-up): the affirmative check runs first and matches
  // the substring "urgent", so a literal "not urgent" is (wrongly) read as urgent.
  // Pinned here so a future negation-handling fix updates this deliberately.
  it("currently mis-reads 'not urgent' as urgent (documented quirk)", () => {
    expect(readUrgencySignal(true, "not urgent")).toBe("urgent");
  });
});
