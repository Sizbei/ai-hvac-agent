import { describe, it, expect } from "vitest";
import {
  arrivalWindowForDate,
  ARRIVAL_WINDOWS,
  formatArrivalWindow,
  type ArrivalWindow,
} from "./arrival-window";

// A fixed local date to anchor the window math (no Date.now()).
const DAY = new Date("2026-06-10T00:00:00");

describe("arrivalWindowForDate", () => {
  it("morning = 8am–12pm on the given day", () => {
    const { start, end } = arrivalWindowForDate(DAY, "morning");
    expect(start.getHours()).toBe(8);
    expect(end.getHours()).toBe(12);
    // same calendar day
    expect(start.getDate()).toBe(end.getDate());
  });

  it("afternoon = 12pm–4pm, evening = 4pm–8pm", () => {
    expect(arrivalWindowForDate(DAY, "afternoon").start.getHours()).toBe(12);
    expect(arrivalWindowForDate(DAY, "afternoon").end.getHours()).toBe(16);
    expect(arrivalWindowForDate(DAY, "evening").start.getHours()).toBe(16);
    expect(arrivalWindowForDate(DAY, "evening").end.getHours()).toBe(20);
  });

  it("anytime = a full business day 8am–8pm", () => {
    const { start, end } = arrivalWindowForDate(DAY, "anytime");
    expect(start.getHours()).toBe(8);
    expect(end.getHours()).toBe(20);
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
