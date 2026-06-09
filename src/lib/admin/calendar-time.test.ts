import { describe, it, expect } from "vitest";
import {
  toBusinessWallClock,
  businessOffsetMinutes,
  businessWallClockToUtc,
  businessMinutesOfDay,
  businessIsoDate,
  placeJobInGrid,
  hourRowLabels,
  formatBusinessTime,
  businessWeekDates,
  arrivalWindowUtcForBusinessDate,
  windowBandPlacement,
  windowRowOfInstant,
  isRealIsoDate,
  CALENDAR_START_HOUR,
  CALENDAR_END_HOUR,
} from "./calendar-time";

// New York is UTC-5 in winter (EST) and UTC-4 in summer (EDT). 2026 DST runs
// Mar 8 → Nov 1. These fixtures pin both sides of the boundary so the math is
// verified to come from real instants, not a fixed offset.
const WINTER_8AM_UTC = "2026-01-15T13:00:00.000Z"; // 08:00 EST (UTC-5)
const SUMMER_8AM_UTC = "2026-07-01T12:00:00.000Z"; // 08:00 EDT (UTC-4)

describe("toBusinessWallClock", () => {
  it("renders a winter instant in EST (UTC-5)", () => {
    const wc = toBusinessWallClock(new Date(WINTER_8AM_UTC));
    expect(wc).toEqual({ year: 2026, month: 1, day: 15, hour: 8, minute: 0 });
  });

  it("renders a summer instant in EDT (UTC-4) — one hour different offset", () => {
    const wc = toBusinessWallClock(new Date(SUMMER_8AM_UTC));
    expect(wc).toEqual({ year: 2026, month: 7, day: 1, hour: 8, minute: 0 });
  });
});

describe("businessOffsetMinutes", () => {
  it("is -300 (UTC-5) in winter and -240 (UTC-4) in summer", () => {
    expect(businessOffsetMinutes(new Date(WINTER_8AM_UTC))).toBe(-300);
    expect(businessOffsetMinutes(new Date(SUMMER_8AM_UTC))).toBe(-240);
  });
});

describe("businessWallClockToUtc", () => {
  it("maps 8am EST back to the winter UTC instant (round-trip)", () => {
    const utc = businessWallClockToUtc("2026-01-15", 8, 0);
    expect(utc.toISOString()).toBe(WINTER_8AM_UTC);
  });

  it("maps 8am EDT back to the summer UTC instant (different offset)", () => {
    const utc = businessWallClockToUtc("2026-07-01", 8, 0);
    expect(utc.toISOString()).toBe(SUMMER_8AM_UTC);
  });

  it("round-trips every hour across the spring-forward DST boundary", () => {
    // Mar 8 2026 is spring-forward (2:00 → 3:00 local). Wall times from the grid
    // start (7am) onward exist on both sides; round-tripping must be stable.
    for (let hour = CALENDAR_START_HOUR; hour < CALENDAR_END_HOUR; hour += 1) {
      const utc = businessWallClockToUtc("2026-03-08", hour, 0);
      const wc = toBusinessWallClock(utc);
      expect(wc.hour).toBe(hour);
      expect(wc.day).toBe(8);
    }
  });

  it("round-trips every hour across the fall-back DST boundary", () => {
    // Nov 1 2026 is fall-back (2:00 → 1:00 local). Grid hours (7am+) are after
    // the transition, so each must map to a unique EST instant.
    for (let hour = CALENDAR_START_HOUR; hour < CALENDAR_END_HOUR; hour += 1) {
      const utc = businessWallClockToUtc("2026-11-01", hour, 0);
      const wc = toBusinessWallClock(utc);
      expect(wc.hour).toBe(hour);
      expect(wc.day).toBe(1);
    }
  });
});

describe("businessMinutesOfDay / businessIsoDate", () => {
  it("computes minutes-from-midnight in the business zone", () => {
    expect(businessMinutesOfDay(new Date(WINTER_8AM_UTC))).toBe(8 * 60);
    expect(businessMinutesOfDay(new Date(SUMMER_8AM_UTC))).toBe(8 * 60);
  });

  it("derives the business calendar date, not the UTC date", () => {
    // 2026-01-16T02:00Z is still Jan 15, 9pm EST.
    expect(businessIsoDate(new Date("2026-01-16T02:00:00.000Z"))).toBe(
      "2026-01-15",
    );
  });
});

describe("placeJobInGrid", () => {
  it("places a morning window (8–12) in the top portion of a 7–20 grid", () => {
    const p = placeJobInGrid(
      new Date(WINTER_8AM_UTC),
      new Date("2026-01-15T17:00:00.000Z"), // 12:00 EST
    );
    expect(p).not.toBeNull();
    // 8am is one hour into a 13-hour grid (7am start).
    expect(p!.top).toBeCloseTo(1 / 13, 5);
    // 8–12 is 4 hours of 13.
    expect(p!.height).toBeCloseTo(4 / 13, 5);
  });

  it("places identically in summer despite the different UTC offset (DST)", () => {
    const winter = placeJobInGrid(
      new Date(WINTER_8AM_UTC),
      new Date("2026-01-15T17:00:00.000Z"),
    );
    const summer = placeJobInGrid(
      new Date(SUMMER_8AM_UTC),
      new Date("2026-07-01T16:00:00.000Z"), // 12:00 EDT
    );
    expect(summer!.top).toBeCloseTo(winter!.top, 5);
    expect(summer!.height).toBeCloseTo(winter!.height, 5);
  });

  it("clamps a window that opens before the grid start", () => {
    // 6am–9am EST: 6am is before the 7am grid start, so top clamps to 0.
    const p = placeJobInGrid(
      new Date("2026-01-15T11:00:00.000Z"), // 06:00 EST
      new Date("2026-01-15T14:00:00.000Z"), // 09:00 EST
    );
    expect(p).not.toBeNull();
    expect(p!.top).toBe(0);
    expect(p!.height).toBeCloseTo(2 / 13, 5); // visible 7–9 = 2h
  });

  it("returns null for a window entirely outside business hours", () => {
    // 22:00–23:00 EST is after the 20:00 grid end.
    const p = placeJobInGrid(
      new Date("2026-01-16T03:00:00.000Z"), // 22:00 EST
      new Date("2026-01-16T04:00:00.000Z"), // 23:00 EST
    );
    expect(p).toBeNull();
  });
});

describe("hourRowLabels", () => {
  it("labels each grid hour in 12h business clock", () => {
    const labels = hourRowLabels();
    expect(labels[0]).toBe("7 AM");
    expect(labels).toContain("12 PM");
    expect(labels[labels.length - 1]).toBe("7 PM");
    expect(labels).toHaveLength(CALENDAR_END_HOUR - CALENDAR_START_HOUR);
  });
});

describe("formatBusinessTime", () => {
  it("formats in Eastern regardless of the instant's UTC offset", () => {
    expect(formatBusinessTime(new Date(WINTER_8AM_UTC))).toBe("8:00 AM");
    expect(formatBusinessTime(new Date(SUMMER_8AM_UTC))).toBe("8:00 AM");
  });
});

describe("businessWeekDates", () => {
  it("returns 7 Sunday-anchored business dates containing the input", () => {
    // 2026-06-10 is a Wednesday; its week is Sun Jun 7 → Sat Jun 13.
    const week = businessWeekDates("2026-06-10");
    expect(week).toHaveLength(7);
    expect(week[0]).toBe("2026-06-07");
    expect(week[6]).toBe("2026-06-13");
    expect(week).toContain("2026-06-10");
  });
});

describe("arrivalWindowUtcForBusinessDate", () => {
  it("resolves the morning window in EASTERN wall-clock (8–12 ET), not UTC", () => {
    // Summer (EDT, UTC-4): 8 AM ET = 12:00Z, 12 PM ET = 16:00Z. This is the
    // whole point of the helper — arrival-window.ts would give 08:00Z.
    const w = arrivalWindowUtcForBusinessDate("2026-07-01", "morning");
    expect(w.start.toISOString()).toBe("2026-07-01T12:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-07-01T16:00:00.000Z");
  });

  it("handles the winter offset (EST, UTC-5): 8 AM ET = 13:00Z", () => {
    const w = arrivalWindowUtcForBusinessDate("2026-01-15", "afternoon");
    // 12 PM ET = 17:00Z, 4 PM ET = 21:00Z in winter.
    expect(w.start.toISOString()).toBe("2026-01-15T17:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-01-15T21:00:00.000Z");
  });
});

describe("windowBandPlacement", () => {
  it("places the morning band as the first slice of the 7am–8pm grid", () => {
    // Grid is 7→20 (13h). Morning 8→12 starts 1h in (1/13) and is 4h tall (4/13).
    const band = windowBandPlacement("morning");
    expect(band).not.toBeNull();
    expect(band?.top).toBeCloseTo(1 / 13, 5);
    expect(band?.height).toBeCloseTo(4 / 13, 5);
  });

  it("places evening (16–20) flush to the bottom of the grid", () => {
    const band = windowBandPlacement("evening");
    expect(band?.top).toBeCloseTo(9 / 13, 5);
    // Bottom is clamped to the 8pm grid end.
    expect((band?.top ?? 0) + (band?.height ?? 0)).toBeCloseTo(1, 5);
  });
});

describe("windowRowOfInstant", () => {
  it("maps an 8 AM ET instant to the morning row", () => {
    expect(windowRowOfInstant(new Date("2026-07-01T12:00:00.000Z"))).toBe(
      "morning",
    );
  });

  it("treats the 12 PM boundary as afternoon (half-open), not morning", () => {
    // 12 PM ET summer = 16:00Z.
    expect(windowRowOfInstant(new Date("2026-07-01T16:00:00.000Z"))).toBe(
      "afternoon",
    );
  });

  it("returns null for an instant outside the discrete bands (e.g. 6 AM)", () => {
    expect(windowRowOfInstant(new Date("2026-07-01T10:00:00.000Z"))).toBeNull();
  });
});

describe("isRealIsoDate", () => {
  it("accepts a real YYYY-MM-DD date", () => {
    expect(isRealIsoDate("2026-06-09")).toBe(true);
    expect(isRealIsoDate("2024-02-29")).toBe(true); // leap day
  });

  it("rejects a syntactically-valid-but-impossible date (round-trip guard)", () => {
    // new Date silently rolls Feb 31 → Mar 3, so the re-serialised date differs.
    expect(isRealIsoDate("2026-02-31")).toBe(false);
    expect(isRealIsoDate("2026-13-01")).toBe(false); // month 13
    expect(isRealIsoDate("2025-02-29")).toBe(false); // not a leap year
    expect(isRealIsoDate("2026-04-31")).toBe(false); // April has 30 days
  });

  it("rejects anything not in strict YYYY-MM-DD shape", () => {
    expect(isRealIsoDate("2026-6-9")).toBe(false);
    expect(isRealIsoDate("06/09/2026")).toBe(false);
    expect(isRealIsoDate("2026-06-09T00:00:00Z")).toBe(false);
    expect(isRealIsoDate("not-a-date")).toBe(false);
    expect(isRealIsoDate("")).toBe(false);
  });
});
