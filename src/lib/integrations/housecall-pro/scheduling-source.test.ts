import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  HcpSchedulingSource,
  HcpAvailabilityCache,
  DEFAULT_HCP_AVAILABILITY_TTL_MS,
} from "./scheduling-source";
import { HCP_SYNTHETIC_TECH_PREFIX } from "./availability-mapping";
import { businessWallClockToUtc } from "@/lib/admin/calendar-time";
import type { HousecallProClient } from "./client";
import type { HousecallAvailabilitySlot } from "./types";

const ORG = "org-1";

/** Build an HCP window from Eastern wall-clock bounds on a business day. */
function win(
  isoDay: string,
  startHour: number,
  endHour: number,
): HousecallAvailabilitySlot {
  return {
    startIso: businessWallClockToUtc(isoDay, startHour, 0).toISOString(),
    endIso: businessWallClockToUtc(isoDay, endHour, 0).toISOString(),
  };
}

/** A client stub whose listAvailability is a spy; all other methods throw if
 * called (this source must only ever read availability). */
function stubClient(
  listAvailability: HousecallProClient["listAvailability"],
): HousecallProClient {
  const reject = () => {
    throw new Error("not expected in scheduling source");
  };
  return {
    listAvailability,
    createCustomer: reject,
    findCustomer: reject,
    createJob: reject,
    updateJob: reject,
    cancelJob: reject,
    getJob: reject,
    getAccountInfo: reject,
  } as unknown as HousecallProClient;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

/** Build a source with a FRESH, isolated cache so conformance tests never share
 * the process-wide default cache (which would leak state between tests). */
function freshSource(
  list: HousecallProClient["listAvailability"],
  org: string = ORG,
): HcpSchedulingSource {
  return new HcpSchedulingSource(
    org,
    stubClient(list),
    new HcpAvailabilityCache(DEFAULT_HCP_AVAILABILITY_TTL_MS),
  );
}

describe("HcpSchedulingSource — conformance + mapping", () => {
  it("maps HCP windows to recurring availability slots (business-tz)", async () => {
    // 2026-07-01 is a Wednesday (dayOfWeek 3).
    const list = vi
      .fn()
      .mockResolvedValue([win("2026-07-01", 8, 12), win("2026-07-01", 13, 17)]);
    const source = freshSource(list);

    const slots = await source.getAvailability();
    expect(slots).toHaveLength(2);
    expect(slots[0]!.dayOfWeek).toBe(3);
    expect(slots[0]!.startMinute).toBe(8 * 60);
    expect(slots[0]!.endMinute).toBe(12 * 60);
  });

  it("reports the synthetic roster matching the mapped slots", async () => {
    const list = vi.fn().mockResolvedValue([win("2026-07-01", 8, 12)]);
    const source = freshSource(list);

    const ids = await source.getActiveTechnicianIds();
    const slots = await source.getAvailability();
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe(slots[0]!.technicianId);
  });

  it("getJobs is always empty (HCP availability is already net of bookings)", async () => {
    const list = vi.fn().mockResolvedValue([win("2026-07-01", 8, 12)]);
    const source = freshSource(list);
    const jobs = await source.getJobs(
      "2026-07-01T00:00:00.000Z",
      "2026-07-02T00:00:00.000Z",
    );
    expect(jobs).toEqual([]);
  });

  it("filters availability to a synthetic tech when one is given", async () => {
    const list = vi
      .fn()
      .mockResolvedValue([win("2026-07-01", 8, 12), win("2026-07-01", 13, 17)]);
    const source = freshSource(list);
    const ids = await source.getActiveTechnicianIds();
    const filtered = await source.getAvailability(ids[1]);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.technicianId).toBe(ids[1]);
  });

  it("NO PII: roster ids are opaque synthetic placeholders, never HCP staff", async () => {
    const list = vi.fn().mockResolvedValue([win("2026-07-01", 8, 12)]);
    const source = freshSource(list);
    const ids = await source.getActiveTechnicianIds();
    expect(
      ids.every((id) => id.startsWith(HCP_SYNTHETIC_TECH_PREFIX)),
    ).toBe(true);
  });

  it("propagates an HCP error (the factory turns this into a DB fallback)", async () => {
    const list = vi.fn().mockRejectedValue(new Error("HCP 503"));
    const source = freshSource(list);
    await expect(source.getAvailability()).rejects.toThrow("HCP 503");
  });
});

describe("HcpSchedulingSource — caching", () => {
  it("hits HCP once across repeated reads within the TTL", async () => {
    const list = vi.fn().mockResolvedValue([win("2026-07-01", 8, 12)]);
    const cache = new HcpAvailabilityCache(30_000, () => 1_000);
    const source = new HcpSchedulingSource(ORG, stubClient(list), cache, () => 1_000);

    await source.getAvailability();
    await source.getActiveTechnicianIds();
    await source.getJobs("a", "b"); // never hits HCP
    expect(list).toHaveBeenCalledOnce();
  });

  it("re-fetches after the TTL expires", async () => {
    const list = vi.fn().mockResolvedValue([win("2026-07-01", 8, 12)]);
    let now = 1_000;
    const cache = new HcpAvailabilityCache(30_000, () => now);
    const source = new HcpSchedulingSource(ORG, stubClient(list), cache, () => now);

    await source.getAvailability();
    now += 31_000; // past the TTL
    await source.getAvailability();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("isolates the cache per organization", async () => {
    const list = vi.fn().mockResolvedValue([win("2026-07-01", 8, 12)]);
    const cache = new HcpAvailabilityCache(30_000, () => 1_000);
    const a = new HcpSchedulingSource("org-a", stubClient(list), cache, () => 1_000);
    const b = new HcpSchedulingSource("org-b", stubClient(list), cache, () => 1_000);

    await a.getAvailability();
    await b.getAvailability();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
