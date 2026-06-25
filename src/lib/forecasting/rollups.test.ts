import { describe, it, expect } from "vitest";
import { buildDemandRows, ALL_JOB_TYPES } from "./rollups";

describe("buildDemandRows", () => {
  it("emits one '__all__' row per day with the total bookings + session funnel", () => {
    const rows = buildDemandRows(
      [
        { day: "2026-06-01", jobType: "no_cool", n: 3 },
        { day: "2026-06-01", jobType: "maintenance", n: 2 },
      ],
      [{ day: "2026-06-01", sessions: 10, booked: 5 }],
    );
    const all = rows.find((r) => r.jobType === ALL_JOB_TYPES && r.day === "2026-06-01")!;
    expect(all.bookings).toBe(5); // 3 + 2
    expect(all.sessions).toBe(10);
    expect(all.booked).toBe(5);
  });

  it("emits a per-jobType row (sessions/booked only on the __all__ row)", () => {
    const rows = buildDemandRows([{ day: "2026-06-01", jobType: "no_cool", n: 3 }], []);
    const perType = rows.find((r) => r.jobType === "no_cool")!;
    expect(perType.bookings).toBe(3);
    expect(perType.sessions).toBe(0);
    expect(perType.booked).toBe(0);
  });

  it("counts a null jobType into the day total but emits no per-type row for it", () => {
    const rows = buildDemandRows([{ day: "2026-06-01", jobType: null, n: 4 }], []);
    const all = rows.find((r) => r.jobType === ALL_JOB_TYPES)!;
    expect(all.bookings).toBe(4);
    expect(rows.filter((r) => r.jobType !== ALL_JOB_TYPES)).toHaveLength(0);
  });

  it("creates a day row from sessions even when there were no bookings", () => {
    const rows = buildDemandRows([], [{ day: "2026-06-02", sessions: 7, booked: 0 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      day: "2026-06-02",
      jobType: ALL_JOB_TYPES,
      bookings: 0,
      sessions: 7,
      booked: 0,
    });
  });

  it("coerces neon-http string aggregates to numbers", () => {
    const rows = buildDemandRows(
      [{ day: "2026-06-01", jobType: "no_cool", n: "3" }],
      [{ day: "2026-06-01", sessions: "10", booked: "5" }],
    );
    const all = rows.find((r) => r.jobType === ALL_JOB_TYPES)!;
    expect(all.bookings).toBe(3);
    expect(all.sessions).toBe(10);
    expect(all.booked).toBe(5);
  });
});
