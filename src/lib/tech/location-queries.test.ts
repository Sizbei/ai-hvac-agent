import { describe, it, expect, vi, beforeEach } from "vitest";

const consentRows = { current: [] as Array<{ enabled: boolean }> };
const locationRows = {
  current: [] as Array<{
    technicianId: string;
    latitude: number;
    longitude: number;
    capturedAt?: Date;
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
        }),
      }),
    }),
    // batch latest-per-tech: DISTINCT ON, .where().orderBy() (awaited directly)
    selectDistinctOn: () => ({
      from: () => ({
        where: () => ({
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
  const NOW = new Date("2026-07-18T12:00:00Z");
  const recent = new Date(NOW.getTime() - 30 * 60 * 1000); // 30 min ago

  it("returns an empty map for no technicians without querying", async () => {
    const m = await getLatestTechnicianLocations("o", []);
    expect(m.size).toBe(0);
  });

  it("keeps only the latest fix per tech (rows arrive newest-first)", async () => {
    // desc(capturedAt) order → first row seen per tech is the latest.
    locationRows.current = [
      { technicianId: "t1", latitude: 36.3, longitude: -82.3, capturedAt: recent }, // latest t1
      { technicianId: "t2", latitude: 40.0, longitude: -75.0, capturedAt: recent }, // latest t2
      { technicianId: "t1", latitude: 10.0, longitude: 10.0, capturedAt: recent }, // older t1 (ignored)
    ];
    const m = await getLatestTechnicianLocations("o", ["t1", "t2"], NOW);
    expect(m.get("t1")).toEqual({ latitude: 36.3, longitude: -82.3 });
    expect(m.get("t2")).toEqual({ latitude: 40.0, longitude: -75.0 });
    expect(m.size).toBe(2);
  });

  it("omits techs with no fix", async () => {
    locationRows.current = [
      { technicianId: "t1", latitude: 36.3, longitude: -82.3, capturedAt: recent },
    ];
    const m = await getLatestTechnicianLocations("o", ["t1", "t2"], NOW);
    expect(m.has("t2")).toBe(false);
  });

  it("omits a tech whose latest fix is STALE (beyond the freshness window)", async () => {
    // A GPS fix is retained ~30 days but is only a LIVE location if recent.
    // A stale fix must be dropped so the caller falls back to home base rather
    // than mis-pricing today's travel term off yesterday's coordinates.
    const stale = new Date(NOW.getTime() - 8 * 60 * 60 * 1000); // 8 hours ago
    locationRows.current = [
      { technicianId: "t1", latitude: 36.3, longitude: -82.3, capturedAt: recent },
      { technicianId: "t2", latitude: 40.0, longitude: -75.0, capturedAt: stale },
    ];
    const m = await getLatestTechnicianLocations("o", ["t1", "t2"], NOW);
    expect(m.has("t1")).toBe(true);
    expect(m.has("t2")).toBe(false);
  });
});
