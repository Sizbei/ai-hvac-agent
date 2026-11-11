import { describe, it, expect, vi, beforeEach } from "vitest";

const loadOrgRow = vi.fn();
const loadOrgRowCached = vi.fn();
vi.mock("./org-row", () => ({
  loadOrgRow: (id: string) => loadOrgRow(id),
  loadOrgRowCached: (id: string) => loadOrgRowCached(id),
}));

import { getCachedFeatures, getCachedHistoryCutoff, getFeatures } from "./features";
import { DEFAULT_FEATURES } from "./feature-flags";

beforeEach(() => {
  loadOrgRow.mockReset();
  loadOrgRowCached.mockReset();
});

describe("getFeatures", () => {
  it("parses the org's flags", async () => {
    loadOrgRow.mockResolvedValue({ status: "active", name: "A", featureFlags: { payLinks: false } });
    expect(await getFeatures("o1")).toEqual({ ...DEFAULT_FEATURES, payLinks: false });
  });
  it("returns defaults when the org row is missing", async () => {
    loadOrgRow.mockResolvedValue(null);
    expect(await getFeatures("o1")).toEqual(DEFAULT_FEATURES);
  });
  it("throws when the lookup throws", async () => {
    loadOrgRow.mockImplementation(async () => {
      throw new Error("db down");
    });
    await expect(getFeatures("o1")).rejects.toThrow("db down");
  });
});

describe("getFeatures stays uncached (money and consent gates fail closed)", () => {
  it("reads the live row, never the TTL cache", async () => {
    loadOrgRow.mockResolvedValue({ status: "active", name: "A", featureFlags: { payLinks: false } });
    await getFeatures("o1");
    expect(loadOrgRow).toHaveBeenCalledWith("o1");
    expect(loadOrgRowCached).not.toHaveBeenCalled();
  });
});

describe("getCachedFeatures / getCachedHistoryCutoff (display reads)", () => {
  it("parse the TTL-cached row", async () => {
    loadOrgRowCached.mockResolvedValue({
      status: "active",
      name: "A",
      featureFlags: { map: true, historyCutoff: "2026-11-10T17:30:00.000Z" },
    });
    expect((await getCachedFeatures("o1")).map).toBe(true);
    expect((await getCachedHistoryCutoff("o1"))?.toISOString()).toBe("2026-11-10T17:30:00.000Z");
    expect(loadOrgRow).not.toHaveBeenCalled();
  });

  it("throw when the lookup throws", async () => {
    loadOrgRowCached.mockRejectedValue(new Error("db down"));
    await expect(getCachedFeatures("o1")).rejects.toThrow("db down");
    await expect(getCachedHistoryCutoff("o1")).rejects.toThrow("db down");
  });
});
