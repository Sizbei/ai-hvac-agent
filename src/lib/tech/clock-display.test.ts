import { describe, it, expect } from "vitest";
import {
  dayClockText,
  formatClockTime,
  formatElapsed,
  formatMinutes,
  jobClockLine,
  JOB_CLOCK_NONE,
  JOB_CLOCK_NOT_STARTED,
} from "./clock-display";

const T0 = "2026-11-05T14:12:00.000Z"; // 9:12 AM in America/New_York
const ms = (iso: string) => new Date(iso).getTime();

describe("formatMinutes", () => {
  it("minutes under an hour", () => expect(formatMinutes(14)).toBe("14m"));
  it("hours and minutes", () => expect(formatMinutes(65)).toBe("1h 5m"));
  it("never negative", () => expect(formatMinutes(-3)).toBe("0m"));
});

describe("formatElapsed", () => {
  it("h:mm:ss over an hour", () => expect(formatElapsed(3725_000)).toBe("1:02:05"));
  it("m:ss under an hour", () => expect(formatElapsed(125_000)).toBe("2:05"));
  it("clamps negatives", () => expect(formatElapsed(-5)).toBe("0:00"));
});

describe("formatClockTime", () => {
  it("12-hour time in the given zone", () => {
    expect(formatClockTime(T0, "America/New_York")).toBe("9:12 AM");
  });
});

describe("jobClockLine", () => {
  it("open entry, no earlier time: since + elapsed", () => {
    expect(
      jobClockLine({ openSince: T0, totalMinutes: 0, nowMs: ms(T0) + 14 * 60_000 + 59_000, timeZone: "America/New_York" }),
    ).toBe("On the clock since 9:12 AM · 14m");
  });
  it("open entry after a pause: adds the whole job's time", () => {
    expect(
      jobClockLine({ openSince: T0, totalMinutes: 30, closedEntries: 1, nowMs: ms(T0) + 12 * 60_000, timeZone: "America/New_York" }),
    ).toBe("On the clock since 9:12 AM · 12m (42m on this job)");
  });
  it("open entry after a 0-minute pause still counts as earlier time", () => {
    expect(
      jobClockLine({ openSince: T0, totalMinutes: 0, closedEntries: 1, nowMs: ms(T0) + 3 * 60_000, timeZone: "America/New_York" }),
    ).toBe("On the clock since 9:12 AM · 3m (3m on this job)");
  });
  it("paused within the first minute: 0m so far, not 'Starts when…'", () => {
    expect(jobClockLine({ openSince: null, totalMinutes: 0, closedEntries: 1, nowMs: 0 })).toBe("0m so far");
  });
  it("closed job: Total", () => {
    expect(jobClockLine({ openSince: null, totalMinutes: 20, closedEntries: 2, jobClosed: true, nowMs: 0 })).toBe("Total 20m");
    expect(jobClockLine({ openSince: null, totalMinutes: 0, jobClosed: true, nowMs: 0 })).toBe(JOB_CLOCK_NONE);
  });
  it("closed time only: the total so far", () => {
    expect(jobClockLine({ openSince: null, totalMinutes: 65, nowMs: 0 })).toBe("1h 5m so far");
  });
  it("nothing yet: points at I've arrived", () => {
    expect(jobClockLine({ openSince: null, totalMinutes: 0, nowMs: 0 })).toBe(JOB_CLOCK_NOT_STARTED);
    expect(JOB_CLOCK_NOT_STARTED).toBe("Starts when you tap I've arrived.");
  });
});

describe("dayClockText", () => {
  it("clocked out: labelled button, no running line", () => {
    expect(dayClockText({ clockInAt: null, nowMs: 0, pending: false })).toEqual({
      running: null,
      button: "Clock in for the day",
    });
  });
  it("loading reads like clocked out", () => {
    expect(dayClockText({ clockInAt: undefined, nowMs: 0, pending: false }).button).toBe("Clock in for the day");
  });
  it("clocked in: Day clock h:mm:ss + Clock out", () => {
    expect(dayClockText({ clockInAt: T0, nowMs: ms(T0) + 3725_000, pending: false })).toEqual({
      running: "Day clock 1:02:05",
      button: "Clock out",
    });
  });
  it("pending copy", () => {
    expect(dayClockText({ clockInAt: null, nowMs: 0, pending: true }).button).toBe("Clocking in…");
    expect(dayClockText({ clockInAt: T0, nowMs: ms(T0), pending: true }).button).toBe("Clocking out…");
  });
});
