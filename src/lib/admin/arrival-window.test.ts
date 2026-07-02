import { describe, it, expect } from "vitest";
import {
  arrivalWindowForDate,
  ARRIVAL_WINDOWS,
  formatArrivalWindow,
  formatArrivalWindowSpoken,
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
  it("renders a non-empty human window label from start/end ISO", () => {
    const { start, end } = arrivalWindowForDate(DAY, "morning");
    const label = formatArrivalWindow(start.toISOString(), end.toISOString());
    // Locale/format of the label is environment-dependent; assert only that a
    // non-empty range with a separator is produced (the exact day/time wording
    // is covered by the UTC-hours assertions above, which are locale-free).
    expect(label).not.toBeNull();
    expect(label).toContain("–");
    expect((label as string).length).toBeGreaterThan(0);
  });

  it("returns null when either bound is missing", () => {
    expect(formatArrivalWindow(null, null)).toBeNull();
    expect(formatArrivalWindow("2026-06-10T08:00:00Z", null)).toBeNull();
  });
});

describe("formatArrivalWindowSpoken", () => {
  it("renders a spoken-friendly window with no en-dash", () => {
    const { start, end } = arrivalWindowForDate(DAY, "morning");
    const label = formatArrivalWindowSpoken(
      start.toISOString(),
      end.toISOString(),
    );
    expect(label).not.toBeNull();
    // Spoken variant must not carry the en-dash (reads awkwardly aloud) and
    // should join the bounds with the word "between".
    expect(label).not.toContain("–");
    expect(label).toContain("between");
    // UTC-anchored, locale forced to en-US, so the wording is stable.
    expect(label).toBe("Wednesday, June 10 between 8 AM and 12 PM");
  });

  it("returns null when either bound is missing or invalid", () => {
    expect(formatArrivalWindowSpoken(null, null)).toBeNull();
    expect(formatArrivalWindowSpoken("2026-06-10T08:00:00Z", null)).toBeNull();
    expect(formatArrivalWindowSpoken("not-a-date", "also-bad")).toBeNull();
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

import { arrivalWindowForSlot } from "./capacity-hold";
import { BUSINESS_TIME_ZONE } from "./calendar-time";

describe("formatArrivalWindow — business-timezone rendering (book-on-the-call)", () => {
  it("renders a slot-anchored (Eastern) held window in ET hours, not UTC", () => {
    // arrivalWindowForSlot anchors band hours in the BUSINESS tz: a morning slot
    // is 8 AM–12 PM ET = 12:00Z–16:00Z (EDT). The customer-facing label must show
    // 8 AM (business tz), never 12 PM (raw UTC) — else we'd promise the wrong hours.
    const { startUtc, endUtc } = arrivalWindowForSlot("2026-07-08", "morning");
    const label = formatArrivalWindow(
      startUtc.toISOString(),
      endUtc.toISOString(),
      BUSINESS_TIME_ZONE,
    );
    expect(label).toContain("8:00");
    expect(label).toContain("12:00");
    expect(label).not.toContain("4:00"); // the UTC-rendered (wrong) hour

    const spoken = formatArrivalWindowSpoken(
      startUtc.toISOString(),
      endUtc.toISOString(),
      BUSINESS_TIME_ZONE,
    );
    expect(spoken).toContain("8 AM");
    expect(spoken).toContain("12 PM");
  });
});
