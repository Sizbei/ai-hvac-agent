import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoisted mock state ─────────────────────────────────────────────
// A chainable thenable proxy stands in for the drizzle query builder; the
// active-technician select is the only DB read in this module (availability +
// jobs come through the mocked scheduling source).
const { selectQueue, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve(resolved);
        }
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return { selectQueue, chain };
});

vi.mock("@/lib/db", () => ({
  db: { select: () => chain(selectQueue.shift() ?? []) },
}));

vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_table: unknown, orgId: string, ...conditions: unknown[]) => ({
    __tenant: orgId,
    conditions,
  }),
}));

vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => ["eq", ...a],
}));

vi.mock("@/lib/db/schema", () => ({
  users: { id: "u.id", organizationId: "u.org", role: "u.role", isActive: "u.active" },
}));

// Mock the scheduling source so the seam is exercised but no real DB is hit.
const getAvailabilityMock = vi.fn();
const getJobsMock = vi.fn();
vi.mock("./scheduling-source", () => ({
  getSchedulingSource: (_orgId: string) => ({
    getAvailability: getAvailabilityMock,
    getJobs: getJobsMock,
  }),
}));

import {
  getOpenAvailability,
  businessDaysFrom,
  businessTodayIso,
} from "./availability-queries";
import { businessWallClockToUtc } from "./calendar-time";
import type { AvailabilitySlot, ScheduledJob } from "./types";

const ORG = "org-1";

beforeEach(() => {
  selectQueue.length = 0;
  getAvailabilityMock.mockReset();
  getJobsMock.mockReset();
});

describe("businessDaysFrom", () => {
  it("returns N consecutive business-tz dates starting inclusive", () => {
    expect(businessDaysFrom("2026-07-01", 3)).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ]);
  });

  it("crosses a month boundary correctly", () => {
    expect(businessDaysFrom("2026-07-31", 2)).toEqual([
      "2026-07-31",
      "2026-08-01",
    ]);
  });

  it("is DST-robust across the spring-forward weekend (no dropped/repeated day)", () => {
    // 2026 US DST begins Sun Mar 8. Stepping across it must not skip Mar 8.
    expect(businessDaysFrom("2026-03-07", 3)).toEqual([
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
    ]);
  });

  it("is DST-robust across the fall-back weekend", () => {
    // 2026 US DST ends Sun Nov 1. The 25h day must not repeat or drop a date.
    expect(businessDaysFrom("2026-10-31", 3)).toEqual([
      "2026-10-31",
      "2026-11-01",
      "2026-11-02",
    ]);
  });

  it("returns an empty list for a zero count", () => {
    expect(businessDaysFrom("2026-07-01", 0)).toEqual([]);
  });
});

describe("businessTodayIso", () => {
  it("resolves the Eastern calendar date of an instant", () => {
    // 2026-07-01T03:00Z is still 2026-06-30 (11pm) in Eastern (EDT, UTC-4).
    expect(businessTodayIso(new Date("2026-07-01T03:00:00Z"))).toBe("2026-06-30");
    // Midday is unambiguously the same date.
    expect(businessTodayIso(new Date("2026-07-01T16:00:00Z"))).toBe("2026-07-01");
  });
});

describe("getOpenAvailability", () => {
  function avail(techId: string): AvailabilitySlot {
    return {
      id: `av-${techId}`,
      technicianId: techId,
      dayOfWeek: 3, // Wednesday
      startMinute: 8 * 60,
      endMinute: 20 * 60,
    };
  }

  it("reads techs from the DB and availability/jobs through the source seam", async () => {
    selectQueue.push([{ id: "t1" }, { id: "t2" }]); // active technician ids
    getAvailabilityMock.mockResolvedValue([avail("t1"), avail("t2")]);
    getJobsMock.mockResolvedValue([]);

    const result = await getOpenAvailability(ORG, ["2026-07-01"]);

    expect(getAvailabilityMock).toHaveBeenCalledOnce();
    expect(getJobsMock).toHaveBeenCalledOnce();
    expect(result.days).toEqual(["2026-07-01"]);
    // Full hours, both techs, no jobs → 3 bands, capacity/available 2.
    expect(result.windows).toHaveLength(3);
    expect(result.windows.every((w) => w.available === 2)).toBe(true);
  });

  it("subtracts a booked job surfaced by the source", async () => {
    selectQueue.push([{ id: "t1" }, { id: "t2" }]);
    getAvailabilityMock.mockResolvedValue([avail("t1"), avail("t2")]);
    const morningJob: ScheduledJob = {
      id: "j1",
      referenceNumber: "HVAC-1",
      status: "scheduled",
      assignedTo: "t1",
      arrivalWindowStart: businessWallClockToUtc("2026-07-01", 8, 0).toISOString(),
      arrivalWindowEnd: businessWallClockToUtc("2026-07-01", 12, 0).toISOString(),
    };
    getJobsMock.mockResolvedValue([morningJob]);

    const result = await getOpenAvailability(ORG, ["2026-07-01"]);
    const morning = result.windows.find((w) => w.window === "morning")!;
    expect(morning.available).toBe(1); // t1 booked, t2 free
  });

  it("passes a job range spanning all requested days to the source", async () => {
    selectQueue.push([{ id: "t1" }]);
    getAvailabilityMock.mockResolvedValue([avail("t1")]);
    getJobsMock.mockResolvedValue([]);

    await getOpenAvailability(ORG, ["2026-07-01", "2026-07-02"]);

    const [startIso, endIso] = getJobsMock.mock.calls[0]!;
    // Range starts at the first day's Eastern midnight…
    expect(startIso).toBe(businessWallClockToUtc("2026-07-01", 0, 0).toISOString());
    // …and ends a full day after the last day's Eastern midnight.
    const lastMidnight = businessWallClockToUtc("2026-07-02", 0, 0).getTime();
    expect(endIso).toBe(new Date(lastMidnight + 24 * 60 * 60 * 1000).toISOString());
  });

  it("returns empty for an empty day list without hitting the source", async () => {
    const result = await getOpenAvailability(ORG, []);
    expect(result).toEqual({ days: [], windows: [] });
    expect(getAvailabilityMock).not.toHaveBeenCalled();
  });
});
