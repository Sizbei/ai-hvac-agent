/**
 * Stage 5 — calendar-robustness concurrency, after-hours-flag correctness, and
 * edge-case guarantees. These exercise the PURE pieces the confirm route
 * composes (pickBookableSlot / arrivalWindowForSlot) plus the after-hours
 * detection engine, locking in the behavior that makes the bot actually comply
 * with the calendar:
 *
 *   - capacity exhaustion: once a band's `available` reaches 0, no further hold
 *     can pick it (the semantic behind "two concurrent confirms can't both take
 *     the last slot" — the route re-reads availability right before the write).
 *   - after-hours-flag correctness: the flag derived from the ARRIVAL-window
 *     instant (a business-hours visit) is FALSE even when the confirm happens at
 *     11pm — so a business-hours booking never gets a surprise after-hours flag.
 *     (There is no dollar surcharge — the charge depends on the work performed.)
 *   - DST + cross-band edge cases on the concrete arrival window.
 */
import { describe, it, expect } from "vitest";
import {
  pickBookableSlot,
  arrivalWindowForSlot,
  availableForBand,
  canHoldSlot,
} from "./capacity-hold";
import {
  isAfterHours,
  DEFAULT_AFTER_HOURS_CONFIG,
} from "./after-hours";
import { toBusinessWallClock } from "./calendar-time";
import type { OpenAvailability } from "./types";

function availability(
  windows: ReadonlyArray<{ day: string; window: string; available: number }>,
): OpenAvailability {
  const days = [...new Set(windows.map((w) => w.day))].sort();
  return {
    days,
    windows: windows.map((w) => ({
      day: w.day,
      window: w.window as never,
      capacity: Math.max(w.available, 1),
      available: w.available,
    })),
  };
}

describe("capacity exhaustion (concurrent-confirm semantics)", () => {
  it("does not pick a band once its available count is 0", () => {
    const full = availability([
      { day: "2026-06-10", window: "morning", available: 0 },
      { day: "2026-06-10", window: "afternoon", available: 0 },
      { day: "2026-06-10", window: "evening", available: 0 },
    ]);
    // A second confirm re-reads availability and sees morning at 0 → no slot.
    expect(pickBookableSlot(full, "morning")).toBeNull();
    expect(canHoldSlot(availableForBand(full, "2026-06-10", "morning"))).toBe(
      false,
    );
  });

  it("the last open slot is takeable exactly once in spirit: available=1 holds, available=0 does not", () => {
    const oneLeft = availability([
      { day: "2026-06-10", window: "morning", available: 1 },
    ]);
    const slot = pickBookableSlot(oneLeft, "morning");
    expect(slot).toEqual({ day: "2026-06-10", window: "morning" });
    expect(canHoldSlot(availableForBand(oneLeft, "2026-06-10", "morning"))).toBe(
      true,
    );

    // After it's consumed (the next re-read shows 0), the same band is refused.
    const consumed = availability([
      { day: "2026-06-10", window: "morning", available: 0 },
    ]);
    expect(pickBookableSlot(consumed, "morning")).toBeNull();
  });

  it("rolls the preferred band forward to the next day that still has capacity", () => {
    const av = availability([
      { day: "2026-06-10", window: "morning", available: 0 },
      { day: "2026-06-11", window: "morning", available: 2 },
    ]);
    expect(pickBookableSlot(av, "morning")).toEqual({
      day: "2026-06-11",
      window: "morning",
    });
  });
});

describe("after-hours flag keyed to the arrival window, not the confirm clock", () => {
  const cfg = DEFAULT_AFTER_HOURS_CONFIG; // 6pm–8am after-hours, Eastern

  it("a business-hours morning arrival is NOT flagged after-hours", () => {
    // Pick a weekday so weekend rules don't interfere (2026-06-10 is a Wed).
    // The point — no surprise after-hours flag on a business-hours booking even
    // when the customer confirms at 11pm — holds with no dollar number.
    const { startUtc } = arrivalWindowForSlot("2026-06-10", "morning");
    const wall = toBusinessWallClock(startUtc);
    expect(wall.hour).toBe(8); // 8am Eastern — inside business hours
    expect(isAfterHours(startUtc, cfg)).toBe(false);
  });

  it("the evening band starts at 4pm (business hours), so it is NOT flagged", () => {
    const { startUtc } = arrivalWindowForSlot("2026-06-10", "evening");
    const wall = toBusinessWallClock(startUtc);
    expect(wall.hour).toBe(16); // 4pm — still business hours, sanity
    // The evening band starts at 4pm (business hours) — this documents that the
    // band's start, not "evening==late", drives the after-hours flag.
    expect(isAfterHours(startUtc, cfg)).toBe(false);
  });
});

describe("arrival window edge cases", () => {
  it("morning is 8:00–12:00 Eastern with end strictly after start", () => {
    const { startUtc, endUtc } = arrivalWindowForSlot("2026-06-10", "morning");
    expect(endUtc.getTime()).toBeGreaterThan(startUtc.getTime());
    expect(toBusinessWallClock(startUtc).hour).toBe(8);
    expect(toBusinessWallClock(endUtc).hour).toBe(12);
  });

  it("handles a winter (EST) day and a summer (EDT) day consistently in wall-clock terms", () => {
    const winter = arrivalWindowForSlot("2026-01-14", "afternoon"); // EST
    const summer = arrivalWindowForSlot("2026-07-15", "afternoon"); // EDT
    expect(toBusinessWallClock(winter.startUtc).hour).toBe(12);
    expect(toBusinessWallClock(summer.startUtc).hour).toBe(12);
  });
});
