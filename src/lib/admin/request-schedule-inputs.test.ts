import { describe, it, expect } from "vitest";
import { canSaveSchedule, scheduleInputsFrom } from "./request-schedule-inputs";
import { arrivalWindowUtcForBusinessDate } from "./calendar-time";

describe("scheduleInputsFrom", () => {
  it("reads a business-anchored band back as that band", () => {
    const { start, end } = arrivalWindowUtcForBusinessDate("2026-11-05", "afternoon");
    expect(scheduleInputsFrom(start.toISOString(), start.toISOString(), end.toISOString())).toEqual({
      date: "2026-11-05",
      window: "afternoon",
    });
  });

  it("uses the business date, not the UTC date, for an evening window", () => {
    // 4–8 PM Eastern on Aug 18 ends at 00:00Z Aug 19.
    const { start, end } = arrivalWindowUtcForBusinessDate("2026-08-18", "evening");
    expect(end.toISOString().slice(0, 10)).toBe("2026-08-19");
    expect(scheduleInputsFrom(null, start.toISOString(), end.toISOString())).toEqual({
      date: "2026-08-18",
      window: "evening",
    });
  });

  it("an 11:03 PM slot keeps its business date and matches no band", () => {
    // 2026-08-19T03:03Z = Aug 18, 11:03 PM Eastern (EDT).
    expect(scheduleInputsFrom(null, "2026-08-19T03:03:00.000Z", "2026-08-19T05:03:00.000Z")).toEqual({
      date: "2026-08-18",
      window: null,
    });
  });

  it("recognises anytime", () => {
    const { start, end } = arrivalWindowUtcForBusinessDate("2026-01-10", "anytime");
    expect(scheduleInputsFrom(null, start.toISOString(), end.toISOString()).window).toBe("anytime");
  });

  it("a date without a window keeps the stored UTC-midnight day", () => {
    expect(scheduleInputsFrom("2026-03-04T00:00:00.000Z", null, null)).toEqual({ date: "2026-03-04", window: null });
  });

  it("nothing scheduled, or garbage, is empty", () => {
    expect(scheduleInputsFrom(null, null, null)).toEqual({ date: "", window: null });
    expect(scheduleInputsFrom("nope", "bad", "worse")).toEqual({ date: "", window: null });
  });
});

describe("canSaveSchedule", () => {
  const current = { date: "2026-11-05", window: "afternoon" as const };
  it("refuses an untouched choice (Save must not widen anything)", () => {
    expect(canSaveSchedule(current, current)).toBe(false);
  });
  it("refuses an incomplete choice", () => {
    expect(canSaveSchedule(current, { date: "2026-11-06", window: null })).toBe(false);
    expect(canSaveSchedule(current, { date: "", window: "morning" })).toBe(false);
  });
  it("allows a changed date or window", () => {
    expect(canSaveSchedule(current, { date: "2026-11-06", window: "afternoon" })).toBe(true);
    expect(canSaveSchedule(current, { date: "2026-11-05", window: "morning" })).toBe(true);
  });
});
