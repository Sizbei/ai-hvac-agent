import { describe, it, expect, vi, beforeEach } from "vitest";

const consentRows = { current: [] as Array<{ enabled: boolean }> };
const locationRows = {
  current: [] as Array<{
    technicianId: string;
    latitude: number;
    longitude: number;
  }>,
};
const insertValues = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          // consent check: .where().limit()
          limit: () => Promise.resolve(consentRows.current),
          // batch latest-per-tech: .where().orderBy() (awaited directly)
          orderBy: () => Promise.resolve(locationRows.current),
        }),
      }),
    }),
    insert: () => ({ values: insertValues.mockResolvedValue(undefined) }),
  },
}));
vi.mock("@/lib/db/tenant", () => ({ withTenant: () => ({}) }));

import {
  isValidCoordinate,
  recordTechnicianLocation,
  getLatestTechnicianLocations,
} from "./location-queries";

beforeEach(() => {
  vi.clearAllMocks();
  consentRows.current = [];
  locationRows.current = [];
});

const fix = {
  latitude: 36.334,
  longitude: -82.381,
  capturedAt: new Date("2026-07-01T12:00:00Z"),
};

describe("isValidCoordinate", () => {
  it("accepts valid WGS84 coords and rejects out-of-range / non-finite", () => {
    expect(isValidCoordinate(36.3, -82.4)).toBe(true);
    expect(isValidCoordinate(91, 0)).toBe(false);
    expect(isValidCoordinate(0, 181)).toBe(false);
    expect(isValidCoordinate(NaN, 0)).toBe(false);
  });
});

describe("recordTechnicianLocation", () => {
  it("rejects invalid coordinates without touching the DB", async () => {
    const r = await recordTechnicianLocation("o", "t", {
      ...fix,
      latitude: 999,
    });
    expect(r).toEqual({ ok: false, reason: "invalid_input" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("refuses when the tech has NOT consented (no insert)", async () => {
    consentRows.current = [{ enabled: false }];
    const r = await recordTechnicianLocation("o", "t", fix);
    expect(r).toEqual({ ok: false, reason: "no_consent" });
    expect(insertValues).not.toHaveBeenCalled();
  });

  it("stores the fix when the tech consents", async () => {
    consentRows.current = [{ enabled: true }];
    const r = await recordTechnicianLocation("o", "t", fix);
    expect(r).toEqual({ ok: true });
    expect(insertValues).toHaveBeenCalledOnce();
  });
});

describe("getLatestTechnicianLocations (batch, one query)", () => {
  it("returns an empty map for no technicians without querying", async () => {
    const m = await getLatestTechnicianLocations("o", []);
    expect(m.size).toBe(0);
  });

  it("keeps only the latest fix per tech (rows arrive newest-first)", async () => {
    // desc(capturedAt) order → first row seen per tech is the latest.
    locationRows.current = [
      { technicianId: "t1", latitude: 36.3, longitude: -82.3 }, // latest t1
      { technicianId: "t2", latitude: 40.0, longitude: -75.0 }, // latest t2
      { technicianId: "t1", latitude: 10.0, longitude: 10.0 }, // older t1 (ignored)
    ];
    const m = await getLatestTechnicianLocations("o", ["t1", "t2"]);
    expect(m.get("t1")).toEqual({ latitude: 36.3, longitude: -82.3 });
    expect(m.get("t2")).toEqual({ latitude: 40.0, longitude: -75.0 });
    expect(m.size).toBe(2);
  });

  it("omits techs with no fix", async () => {
    locationRows.current = [
      { technicianId: "t1", latitude: 36.3, longitude: -82.3 },
    ];
    const m = await getLatestTechnicianLocations("o", ["t1", "t2"]);
    expect(m.has("t2")).toBe(false);
  });
});
