import { describe, it, expect, vi, beforeEach } from "vitest";

const loadOrgRow = vi.fn();
vi.mock("./org-row", () => ({ loadOrgRow: (id: string) => loadOrgRow(id) }));

import { getFeatures } from "./features";
import { DEFAULT_FEATURES } from "./feature-flags";

beforeEach(() => {
  loadOrgRow.mockReset();
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
