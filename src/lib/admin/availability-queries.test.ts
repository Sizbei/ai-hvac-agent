import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the scheduling source so the seam is exercised but no real DB is hit.
// Every fact — roster, availability, jobs — comes through the source now, so
// this module makes no direct DB read and needs no db mock. Hoisted together
// (mocks + a stand-in DbSchedulingSource) so the vi.mock factory — which is
// hoisted above module-level declarations — can reference them safely.
const {
  getActiveTechnicianIdsMock,
  getAvailabilityMock,
  getJobsMock,
  dbActiveTechIdsMock,
  dbAvailabilityMock,
  dbJobsMock,
  getSchedulingSourceMock,
  FakeDbSchedulingSource,
} = vi.hoisted(() => {
  // Separate mock sets for the ACTIVE source (returned by the factory — could be
  // HCP) and the DB FALLBACK source the module constructs directly. Keeping them
  // distinct lets a test fail the active source and assert the DB fallback fed
  // the open-window math.
  const dbActiveTechIdsMock = vi.fn();
  const dbAvailabilityMock = vi.fn();
  const dbJobsMock = vi.fn();
  // A stand-in DbSchedulingSource so `instanceof DbSchedulingSource` branching
  // in the module under test resolves; its methods delegate to the DB mocks so a
  // test can control what the fallback returns.
  class FakeDbSchedulingSource {
    getActiveTechnicianIds = dbActiveTechIdsMock;
    getAvailability = dbAvailabilityMock;
    getJobs = dbJobsMock;
  }
  return {
    getActiveTechnicianIdsMock: vi.fn(),
    getAvailabilityMock: vi.fn(),
    getJobsMock: vi.fn(),
    dbActiveTechIdsMock,
    dbAvailabilityMock,
    dbJobsMock,
    getSchedulingSourceMock: vi.fn(),
    FakeDbSchedulingSource,
  };
});

vi.mock("./scheduling-source", () => ({
  getSchedulingSource: getSchedulingSourceMock,
  DbSchedulingSource: FakeDbSchedulingSource,
}));

import {
  getOpenAvailability,
  businessDaysFrom,
  businessTodayIso,
} from "./availability-queries";
import { businessWallClockToUtc } from "./calendar-time";
import type { AvailabilitySlot, ScheduledJob } from "./types";

const ORG = "org-1";

/** The ACTIVE (non-DB) source the factory returns by default — a plain object,
 * so `instanceof DbSchedulingSource` is false and the HCP-error fallback path is
 * reachable. */
const activeSource = {
  getActiveTechnicianIds: getActiveTechnicianIdsMock,
  getAvailability: getAvailabilityMock,
  getJobs: getJobsMock,
};

beforeEach(() => {
  getActiveTechnicianIdsMock.mockReset();
  getAvailabilityMock.mockReset();
  getJobsMock.mockReset();
  dbActiveTechIdsMock.mockReset();
  dbAvailabilityMock.mockReset();
  dbJobsMock.mockReset();
  getSchedulingSourceMock.mockReset();
  getSchedulingSourceMock.mockResolvedValue(activeSource);
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

  it("reads roster + availability + jobs through the source seam", async () => {
    getActiveTechnicianIdsMock.mockResolvedValue(["t1", "t2"]);
    getAvailabilityMock.mockResolvedValue([avail("t1"), avail("t2")]);
    getJobsMock.mockResolvedValue([]);

    const result = await getOpenAvailability(ORG, ["2026-07-01"]);

    expect(getActiveTechnicianIdsMock).toHaveBeenCalledOnce();
    expect(getAvailabilityMock).toHaveBeenCalledOnce();
    expect(getJobsMock).toHaveBeenCalledOnce();
    expect(result.days).toEqual(["2026-07-01"]);
    // Full hours, both techs, no jobs → 3 bands, capacity/available 2.
    expect(result.windows).toHaveLength(3);
    expect(result.windows.every((w) => w.available === 2)).toBe(true);
  });

  it("subtracts a booked job surfaced by the source", async () => {
    getActiveTechnicianIdsMock.mockResolvedValue(["t1", "t2"]);
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
    getActiveTechnicianIdsMock.mockResolvedValue(["t1"]);
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

  it("falls back to the DB source when the active (HCP) source errors", async () => {
    // Active source (e.g. HCP) blows up on a read…
    getActiveTechnicianIdsMock.mockRejectedValue(new Error("HCP 503"));
    getAvailabilityMock.mockResolvedValue([]);
    getJobsMock.mockResolvedValue([]);
    // …and the DB fallback answers with real data so the customer still gets slots.
    dbActiveTechIdsMock.mockResolvedValue(["t1"]);
    dbAvailabilityMock.mockResolvedValue([avail("t1")]);
    dbJobsMock.mockResolvedValue([]);

    const result = await getOpenAvailability(ORG, ["2026-07-01"]);

    // DB fallback was used (one covered tech → 3 bands, available 1 each).
    expect(dbActiveTechIdsMock).toHaveBeenCalledOnce();
    expect(result.windows).toHaveLength(3);
    expect(result.windows.every((w) => w.available === 1)).toBe(true);
  });

  it("propagates the error when the DB source itself fails (no infinite fallback)", async () => {
    // The factory returns the DB source AND it fails → there's nothing to fall
    // back to, so the error must surface rather than loop.
    getSchedulingSourceMock.mockResolvedValue(new FakeDbSchedulingSource());
    dbActiveTechIdsMock.mockRejectedValue(new Error("DB down"));
    dbAvailabilityMock.mockResolvedValue([]);
    dbJobsMock.mockResolvedValue([]);

    await expect(getOpenAvailability(ORG, ["2026-07-01"])).rejects.toThrow(
      "DB down",
    );
  });
});
