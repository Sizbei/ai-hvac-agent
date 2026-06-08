import { describe, it, expect } from "vitest";
import {
  arrivalWindowForDate,
  ARRIVAL_WINDOWS,
  formatArrivalWindow,
  type ArrivalWindow,
} from "./arrival-window";

// A fixed UTC midnight date to anchor the window math (no Date.now()). The
// window is computed in UTC (TZ-independent), so we assert UTC hours/day.
const DAY = new Date("2026-06-10T00:00:00.000Z");

describe("arrivalWindowForDate", () => {
  it("morning = 8am–12pm UTC on the given day", () => {
    const { start, end } = arrivalWindowForDate(DAY, "morning");
    expect(start.getUTCHours()).toBe(8);
    expect(end.getUTCHours()).toBe(12);
    // same calendar day the dispatcher picked, regardless of server TZ
    expect(start.getUTCDate()).toBe(10);
    expect(end.getUTCDate()).toBe(10);
  });

  it("afternoon = 12pm–4pm, evening = 4pm–8pm (UTC)", () => {
    expect(arrivalWindowForDate(DAY, "afternoon").start.getUTCHours()).toBe(12);
    expect(arrivalWindowForDate(DAY, "afternoon").end.getUTCHours()).toBe(16);
    expect(arrivalWindowForDate(DAY, "evening").start.getUTCHours()).toBe(16);
    expect(arrivalWindowForDate(DAY, "evening").end.getUTCHours()).toBe(20);
  });

  it("anytime = a full business day 8am–8pm (UTC)", () => {
    const { start, end } = arrivalWindowForDate(DAY, "anytime");
    expect(start.getUTCHours()).toBe(8);
    expect(end.getUTCHours()).toBe(20);
  });

  it("start is always before end", () => {
    for (const w of ARRIVAL_WINDOWS) {
      const { start, end } = arrivalWindowForDate(DAY, w);
      expect(start.getTime()).toBeLessThan(end.getTime());
    }
  });
});

describe("formatArrivalWindow", () => {
  it("renders a human window label from start/end ISO", () => {
    const { start, end } = arrivalWindowForDate(DAY, "morning");
    const label = formatArrivalWindow(start.toISOString(), end.toISOString());
    expect(label).toMatch(/Jun(e)?\s*10/i);
    // contains a time range
    expect(label).toMatch(/\d/);
  });

  it("returns null when either bound is missing", () => {
    expect(formatArrivalWindow(null, null)).toBeNull();
    expect(formatArrivalWindow("2026-06-10T08:00:00Z", null)).toBeNull();
  });
});

describe("ARRIVAL_WINDOWS", () => {
  it("lists the selectable windows", () => {
    expect(ARRIVAL_WINDOWS).toEqual([
      "morning",
      "afternoon",
      "evening",
      "anytime",
    ] satisfies ArrivalWindow[]);
  });
});
