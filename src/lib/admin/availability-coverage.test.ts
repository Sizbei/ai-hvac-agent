import { describe, it, expect } from "vitest";
import {
  businessWeekday,
  isWindowWithinAvailability,
} from "./availability-coverage";
import type { AvailabilitySlot } from "./types";

const TECH = "tech-a";

function slot(overrides: Partial<AvailabilitySlot>): AvailabilitySlot {
  return {
    id: "av",
    technicianId: TECH,
    dayOfWeek: 3, // Wednesday by default
    startMinute: 8 * 60,
    endMinute: 17 * 60,
    ...overrides,
  };
}

describe("businessWeekday", () => {
  it("resolves the Eastern weekday for a date (Wed)", () => {
    // 2026-07-01 is a Wednesday.
    expect(businessWeekday("2026-07-01")).toBe(3);
  });

  it("resolves Sunday as 0", () => {
    // 2026-07-05 is a Sunday.
    expect(businessWeekday("2026-07-05")).toBe(0);
  });

  it("is DST-robust: a winter date resolves the correct weekday", () => {
    // 2026-01-01 is a Thursday (EST, UTC-5).
    expect(businessWeekday("2026-01-01")).toBe(4);
  });
});

describe("isWindowWithinAvailability", () => {
  // 2026-07-01 = Wednesday (weekday 3).
  const WED_DAY = "2026-07-01";

  it("covers a window fully inside a single shift", () => {
    const slots = [slot({ startMinute: 8 * 60, endMinute: 17 * 60 })];
    // morning = 8–12 ⊂ 8–17.
    expect(isWindowWithinAvailability(slots, WED_DAY, "morning")).toBe(true);
  });

  it("does NOT cover a window extending past the shift end (boundary)", () => {
    // Shift ends 11am; morning is 8–12 → 11–12 is uncovered.
    const slots = [slot({ startMinute: 8 * 60, endMinute: 11 * 60 })];
    expect(isWindowWithinAvailability(slots, WED_DAY, "morning")).toBe(false);
  });

  it("does NOT cover a window starting before the shift", () => {
    // Shift starts 9am; morning starts 8am → 8–9 is uncovered.
    const slots = [slot({ startMinute: 9 * 60, endMinute: 17 * 60 })];
    expect(isWindowWithinAvailability(slots, WED_DAY, "morning")).toBe(false);
  });

  it("covers a window that spans two TOUCHING split shifts", () => {
    // 8–12 and 12–16 touch at noon → afternoon (12–16) is covered, and a
    // morning+afternoon span would be too. afternoon ⊂ the second shift.
    const slots = [
      slot({ startMinute: 8 * 60, endMinute: 12 * 60 }),
      slot({ startMinute: 12 * 60, endMinute: 16 * 60 }),
    ];
    expect(isWindowWithinAvailability(slots, WED_DAY, "afternoon")).toBe(true);
  });

  it("does NOT cover a window falling in a GAP between split shifts", () => {
    // 8–11 and 13–17 leave 11–13 uncovered; morning (8–12) crosses into the gap.
    const slots = [
      slot({ startMinute: 8 * 60, endMinute: 11 * 60 }),
      slot({ startMinute: 13 * 60, endMinute: 17 * 60 }),
    ];
    expect(isWindowWithinAvailability(slots, WED_DAY, "morning")).toBe(false);
  });

  it("ignores slots for a different weekday", () => {
    // The only slot is on Monday (1); the day is Wednesday → nothing covers it.
    const slots = [slot({ dayOfWeek: 1, startMinute: 8 * 60, endMinute: 17 * 60 })];
    expect(isWindowWithinAvailability(slots, WED_DAY, "morning")).toBe(false);
  });

  it("falls back to DEFAULT business hours when the tech has NO rows at all", () => {
    // Bug-1 fix: an unconfigured tech (zero rows) is usable on a weekday during
    // the bounded Mon–Fri 8–8 default, rather than reading as fully out-of-hours.
    expect(isWindowWithinAvailability([], WED_DAY, "morning")).toBe(true);
    expect(isWindowWithinAvailability([], WED_DAY, "evening")).toBe(true);
    expect(isWindowWithinAvailability([], WED_DAY, "anytime")).toBe(true);
  });

  it("keeps an unconfigured tech OFF on weekends (default is Mon–Fri only)", () => {
    // 2026-07-05 is a Sunday.
    expect(isWindowWithinAvailability([], "2026-07-05", "morning")).toBe(false);
  });

  it("does NOT fall back when the tech HAS rows but none on that weekday", () => {
    // A tech configured for Monday only is genuinely OFF on Wednesday — this is a
    // real day off, not the unconfigured state, so no default-hours fallback.
    const monOnly = [slot({ dayOfWeek: 1, startMinute: 8 * 60, endMinute: 20 * 60 })];
    expect(isWindowWithinAvailability(monOnly, WED_DAY, "morning")).toBe(false);
  });

  it("covers evening only when the shift reaches 8pm", () => {
    // evening = 16–20. A shift ending at 17:00 (1020) leaves 17–20 uncovered.
    const short = [slot({ startMinute: 8 * 60, endMinute: 17 * 60 })];
    expect(isWindowWithinAvailability(short, WED_DAY, "evening")).toBe(false);
    const full = [slot({ startMinute: 8 * 60, endMinute: 20 * 60 })];
    expect(isWindowWithinAvailability(full, WED_DAY, "evening")).toBe(true);
  });
});
