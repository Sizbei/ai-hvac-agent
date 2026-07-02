import { describe, it, expect, vi, beforeEach } from "vitest";

const consentRows = { current: [] as Array<{ enabled: boolean }> };
const insertValues = vi.fn();
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(consentRows.current) }),
      }),
    }),
    insert: () => ({ values: insertValues.mockResolvedValue(undefined) }),
  },
}));
vi.mock("@/lib/db/tenant", () => ({ withTenant: () => ({}) }));

import {
  isValidCoordinate,
  recordTechnicianLocation,
} from "./location-queries";

beforeEach(() => {
  vi.clearAllMocks();
  consentRows.current = [];
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
