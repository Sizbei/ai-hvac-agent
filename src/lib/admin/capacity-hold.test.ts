import { describe, it, expect } from "vitest";
import {
  availableForBand,
  pickBookableSlot,
  arrivalWindowForSlot,
  canHoldSlot,
} from "./capacity-hold";
import {
  businessWallClockToUtc,
  toBusinessWallClock,
} from "./calendar-time";
import type { OpenAvailability, OpenWindow } from "./types";

/** Tiny builder so test fixtures read as day+band+available. */
function win(
  day: string,
  window: string,
  available: number,
  capacity = available,
): OpenWindow {
  return { day, window, capacity, available };
}

function avail(
  days: readonly string[],
  windows: readonly OpenWindow[],
): OpenAvailability {
  return { days, windows };
}

describe("availableForBand", () => {
  const a = avail(
    ["2026-06-10", "2026-06-11"],
    [
      win("2026-06-10", "morning", 2),
      win("2026-06-10", "afternoon", 0, 1),
    ],
  );

  it("returns the available count for a present band", () => {
    expect(availableForBand(a, "2026-06-10", "morning")).toBe(2);
  });

  it("returns the available count even when it is zero (present but full)", () => {
    expect(availableForBand(a, "2026-06-10", "afternoon")).toBe(0);
  });

  it("returns 0 for a band absent on a covered day", () => {
    expect(availableForBand(a, "2026-06-10", "evening")).toBe(0);
  });

  it("returns 0 for a day not in the availability at all", () => {
    expect(availableForBand(a, "2026-06-11", "morning")).toBe(0);
  });
});

describe("pickBookableSlot", () => {
  it("returns the preferred band on day 1 when it is open there", () => {
    const a = avail(
      ["2026-06-10", "2026-06-11"],
      [
        win("2026-06-10", "afternoon", 1),
        win("2026-06-11", "afternoon", 3),
      ],
    );
    expect(pickBookableSlot(a, "afternoon")).toEqual({
      day: "2026-06-10",
      window: "afternoon",
    });
  });

  it("skips to day 2 when the preferred band is full on day 1 but open on day 2", () => {
    const a = avail(
      ["2026-06-10", "2026-06-11"],
      [
        win("2026-06-10", "morning", 0, 2),
        win("2026-06-11", "morning", 1),
      ],
    );
    expect(pickBookableSlot(a, "morning")).toEqual({
      day: "2026-06-11",
      window: "morning",
    });
  });

  it("returns null when the preferred band is full on every day", () => {
    const a = avail(
      ["2026-06-10", "2026-06-11"],
      [
        win("2026-06-10", "evening", 0, 1),
        win("2026-06-11", "evening", 0, 2),
      ],
    );
    expect(pickBookableSlot(a, "evening")).toBeNull();
  });

  it("'asap' picks the earliest open band morning-first within the earliest open day", () => {
    // Day 1 has afternoon + evening open but NOT morning; "asap" should still
    // take day 1, and among day 1's open bands prefer the soonest (afternoon).
    const a = avail(
      ["2026-06-10", "2026-06-11"],
      [
        win("2026-06-10", "morning", 0, 1),
        win("2026-06-10", "afternoon", 1),
        win("2026-06-10", "evening", 2),
        win("2026-06-11", "morning", 5),
      ],
    );
    expect(pickBookableSlot(a, "asap")).toEqual({
      day: "2026-06-10",
      window: "afternoon",
    });
  });

  it("'asap' prefers morning when it is open", () => {
    const a = avail(
      ["2026-06-10"],
      [
        win("2026-06-10", "morning", 1),
        win("2026-06-10", "afternoon", 4),
      ],
    );
    expect(pickBookableSlot(a, "asap")).toEqual({
      day: "2026-06-10",
      window: "morning",
    });
  });

  it("'asap' returns null when nothing is open on any day", () => {
    const a = avail(
      ["2026-06-10", "2026-06-11"],
      [
        win("2026-06-10", "morning", 0, 1),
        win("2026-06-11", "afternoon", 0, 2),
      ],
    );
    expect(pickBookableSlot(a, "asap")).toBeNull();
  });

  it("returns null for empty availability", () => {
    expect(pickBookableSlot(avail([], []), "morning")).toBeNull();
    expect(pickBookableSlot(avail([], []), "asap")).toBeNull();
  });
});

describe("arrivalWindowForSlot", () => {
  it("resolves morning to 8:00–12:00 Eastern instants", () => {
    const day = "2026-06-10"; // summer (EDT, UTC-4)
    const { startUtc, endUtc } = arrivalWindowForSlot(day, "morning");

    // Matches the same calendar-time helper the rest of the system uses.
    expect(startUtc.getTime()).toBe(
      businessWallClockToUtc(day, 8, 0).getTime(),
    );
    expect(endUtc.getTime()).toBe(
      businessWallClockToUtc(day, 12, 0).getTime(),
    );

    // End is strictly after start.
    expect(endUtc.getTime()).toBeGreaterThan(startUtc.getTime());

    // Re-deriving the wall clock yields 8:00 and 12:00 Eastern.
    const startWall = toBusinessWallClock(startUtc);
    const endWall = toBusinessWallClock(endUtc);
    expect(startWall.hour).toBe(8);
    expect(startWall.minute).toBe(0);
    expect(endWall.hour).toBe(12);
    expect(endWall.minute).toBe(0);
  });

  it("resolves afternoon to 12:00–16:00 Eastern in winter (DST-correct)", () => {
    const day = "2026-01-15"; // winter (EST, UTC-5)
    const { startUtc, endUtc } = arrivalWindowForSlot(day, "afternoon");
    const startWall = toBusinessWallClock(startUtc);
    const endWall = toBusinessWallClock(endUtc);
    expect(startWall.hour).toBe(12);
    expect(endWall.hour).toBe(16);
    expect(endUtc.getTime()).toBeGreaterThan(startUtc.getTime());
  });
});

describe("canHoldSlot", () => {
  it("is false when no capacity is left", () => {
    expect(canHoldSlot(0)).toBe(false);
  });

  it("is true when one unit is left", () => {
    expect(canHoldSlot(1)).toBe(true);
  });

  it("is true when more than one unit is left", () => {
    expect(canHoldSlot(2)).toBe(true);
  });
});
