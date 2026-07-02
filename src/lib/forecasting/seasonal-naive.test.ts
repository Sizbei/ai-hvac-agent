import { describe, it, expect } from "vitest";
import { seasonalNaive, type DailyPoint } from "./seasonal-naive";

// A series with a clear weekly pattern: Mondays = 10, every other day = 2.
function series(weeks: number): DailyPoint[] {
  const out: DailyPoint[] = [];
  const start = new Date("2026-01-05T00:00:00Z"); // a Monday
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    out.push({ day: d.toISOString().slice(0, 10), value: d.getUTCDay() === 1 ? 10 : 2 });
  }
  return out;
}

describe("seasonalNaive", () => {
  it("forecasts the same weekday's recent average (Monday → 10)", () => {
    const f = seasonalNaive(series(6), 7);
    const mon = f.find((p) => new Date(p.day + "T00:00:00Z").getUTCDay() === 1)!;
    expect(mon.value).toBe(10);
  });

  it("never returns a negative forecast (floored at 0)", () => {
    const f = seasonalNaive(
      [{ day: "2026-01-05", value: 0 }, { day: "2026-01-06", value: 0 }],
      3,
    );
    expect(f.every((p) => p.value >= 0)).toBe(true);
  });

  it("returns exactly horizonDays future points, contiguous from the last day", () => {
    const f = seasonalNaive(series(4), 5);
    expect(f).toHaveLength(5);
    // series(4) = 28 points (i=0..27) from Mon 2026-01-05 → last day i=27 = Sun
    // 2026-02-01; the first forecast is the day AFTER = Mon 2026-02-02.
    expect(f[0].day).toBe("2026-02-02");
  });

  it("falls back to the overall mean when there's <1 week of history", () => {
    const f = seasonalNaive(
      [{ day: "2026-01-05", value: 4 }, { day: "2026-01-06", value: 8 }],
      2,
    );
    expect(f.every((p) => p.value === 6)).toBe(true); // mean(4,8)=6
  });

  it("returns [] for an empty series", () => {
    expect(seasonalNaive([], 7)).toEqual([]);
  });
});
