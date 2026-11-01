import { describe, expect, it } from "vitest";
import { expandDailyShifts } from "./time-off-expand";
import { businessWallClockToUtc } from "./calendar-time";

describe("expandDailyShifts", () => {
  it("one day yields one row", () => {
    const rows = expandDailyShifts("2026-11-10", "2026-11-10", "08:00", "17:00");
    expect(rows).toEqual([
      {
        startsAt: businessWallClockToUtc("2026-11-10", 8, 0).toISOString(),
        endsAt: businessWallClockToUtc("2026-11-10", 17, 0).toISOString(),
      },
    ]);
  });

  it("three days yield three rows with the same clock times", () => {
    const rows = expandDailyShifts("2026-11-10", "2026-11-12", "08:30", "16:45");
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual({
      startsAt: businessWallClockToUtc("2026-11-12", 8, 30).toISOString(),
      endsAt: businessWallClockToUtc("2026-11-12", 16, 45).toISOString(),
    });
  });

  it("keeps the wall-clock time across a DST change", () => {
    const rows = expandDailyShifts("2026-11-01", "2026-11-02", "09:00", "10:00");
    expect(rows[0].startsAt).toBe("2026-11-01T14:00:00.000Z");
    expect(rows[1].startsAt).toBe("2026-11-02T14:00:00.000Z");
  });

  it("returns nothing when the end date is before the start date", () => {
    expect(expandDailyShifts("2026-11-12", "2026-11-10", "08:00", "17:00")).toEqual([]);
  });

  it("returns nothing when the end time is not after the start time", () => {
    expect(expandDailyShifts("2026-11-10", "2026-11-10", "17:00", "08:00")).toEqual([]);
  });

  it("returns nothing for malformed input", () => {
    expect(expandDailyShifts("nope", "2026-11-10", "08:00", "17:00")).toEqual([]);
    expect(expandDailyShifts("2026-11-10", "2026-11-10", "8am", "17:00")).toEqual([]);
  });
});
