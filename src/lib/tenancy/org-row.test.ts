import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const limit = vi.fn();
vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  for (const k of ["from", "where"]) chain[k] = () => chain;
  chain.limit = (...a: unknown[]) => limit(...a);
  return { db: { select: () => chain } };
});

import {
  clearOrgRowCacheForTests,
  invalidateOrgRow,
  loadOrgRow,
  loadOrgRowCached,
  ORG_ROW_TTL_MS,
} from "./org-row";

const ROW = { status: "active", name: "Acme", featureFlags: { map: true } };

beforeEach(() => {
  clearOrgRowCacheForTests();
  limit.mockReset();
  limit.mockResolvedValue([ROW]);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("loadOrgRowCached (30 s per-instance TTL, final wave M2)", () => {
  it("reads once and serves repeats from memory within the TTL", async () => {
    expect(await loadOrgRowCached("o1")).toEqual(ROW);
    vi.advanceTimersByTime(ORG_ROW_TTL_MS - 1);
    expect(await loadOrgRowCached("o1")).toEqual(ROW);
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("re-reads after the TTL", async () => {
    await loadOrgRowCached("o1");
    vi.advanceTimersByTime(ORG_ROW_TTL_MS);
    await loadOrgRowCached("o1");
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("is keyed by org", async () => {
    await loadOrgRowCached("o1");
    await loadOrgRowCached("o2");
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("invalidateOrgRow forces the next read for that org only", async () => {
    await loadOrgRowCached("o1");
    await loadOrgRowCached("o2");
    invalidateOrgRow("o1");
    await loadOrgRowCached("o1");
    await loadOrgRowCached("o2");
    expect(limit).toHaveBeenCalledTimes(3);
  });

  it("a read in flight when the org is invalidated is not stored", async () => {
    let release: (v: unknown) => void = () => {};
    limit.mockReturnValueOnce(new Promise((r) => (release = r)));
    const pending = loadOrgRowCached("o1");
    invalidateOrgRow("o1");
    release([{ ...ROW, featureFlags: { map: false } }]);
    await pending;
    await loadOrgRowCached("o1");
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("caches a missing org as null", async () => {
    limit.mockResolvedValue([]);
    expect(await loadOrgRowCached("gone")).toBeNull();
    expect(await loadOrgRowCached("gone")).toBeNull();
    expect(limit).toHaveBeenCalledTimes(1);
  });

  it("never caches a failed read: it throws and the next call re-reads", async () => {
    limit.mockRejectedValueOnce(new Error("db down"));
    await expect(loadOrgRowCached("o1")).rejects.toThrow("db down");
    expect(await loadOrgRowCached("o1")).toEqual(ROW);
    expect(limit).toHaveBeenCalledTimes(2);
  });

  it("loadOrgRow stays uncached across calls", async () => {
    await loadOrgRow("o1");
    await loadOrgRow("o1");
    expect(limit).toHaveBeenCalledTimes(2);
  });
});
