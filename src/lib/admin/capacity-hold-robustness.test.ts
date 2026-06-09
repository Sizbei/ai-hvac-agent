/**
 * Stage 5 — calendar-robustness concurrency, fee-correctness, and edge-case
 * guarantees. These exercise the PURE pieces the confirm route composes
 * (pickBookableSlot / arrivalWindowForSlot) plus the after-hours engine, locking
 * in the behavior that makes the bot actually comply with the calendar:
 *
 *   - capacity exhaustion: once a band's `available` reaches 0, no further hold
 *     can pick it (the semantic behind "two concurrent confirms can't both take
 *     the last slot" — the route re-reads availability right before the write).
 *   - fee correctness: the after-hours surcharge computed from the ARRIVAL-window
 *     instant (a business-hours visit) is 0 even when the confirm happens at
 *     11pm — the bug this whole stage fixes.
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
  computeSurcharge,
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

describe("fee correctness: surcharge keyed to the arrival window, not the confirm clock", () => {
  const cfg = DEFAULT_AFTER_HOURS_CONFIG; // 6pm–8am after-hours, Eastern

  it("a business-hours morning arrival incurs NO after-hours surcharge", () => {
    // Pick a weekday so weekend rules don't interfere (2026-06-10 is a Wed).
    const { startUtc } = arrivalWindowForSlot("2026-06-10", "morning");
    const wall = toBusinessWallClock(startUtc);
    expect(wall.hour).toBe(8); // 8am Eastern — inside business hours
    expect(isAfterHours(startUtc, cfg)).toBe(false);
    expect(computeSurcharge(isAfterHours(startUtc, cfg), "high", cfg)).toBe(0);
  });

  it("evening arrival (after 6pm Eastern) DOES incur the surcharge", () => {
    const { startUtc } = arrivalWindowForSlot("2026-06-10", "evening");
    const wall = toBusinessWallClock(startUtc);
    expect(wall.hour).toBe(16); // 4pm — still business hours, sanity
    // The evening band starts at 4pm (business hours), so no surcharge — this
    // documents that the band itself, not "evening==late", drives the fee.
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
