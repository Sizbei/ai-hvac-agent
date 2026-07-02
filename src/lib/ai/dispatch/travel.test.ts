import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { durationMatrix, routingEnabled } from "./travel";

const ORIGINS = [
  { lat: 36.3, lon: -82.4 },
  { lat: 36.1, lon: -82.0 },
];
const DEST = { lat: 36.33, lon: -82.38 };

const ENV_KEYS = ["ROUTING_PROVIDER", "ORS_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  vi.restoreAllMocks();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function mockFetch(impl: () => Promise<Response> | Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(impl as never);
}
const json = (body: unknown, ok = true) =>
  ({ ok, json: async () => body }) as Response;

describe("durationMatrix", () => {
  it("returns [] for no origins without a network call", async () => {
    const f = mockFetch(() => json({}));
    expect(await durationMatrix([], DEST)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
  });

  it("provider unset (default none) → all null, no network call (haversine fallback)", async () => {
    delete process.env.ROUTING_PROVIDER;
    const f = mockFetch(() => json({}));
    expect(await durationMatrix(ORIGINS, DEST)).toEqual([null, null]);
    expect(f).not.toHaveBeenCalled();
    expect(routingEnabled()).toBe(false);
  });

  it("ors selected but no key → all null (never calls out)", async () => {
    process.env.ROUTING_PROVIDER = "ors";
    delete process.env.ORS_API_KEY;
    const f = mockFetch(() => json({}));
    expect(await durationMatrix(ORIGINS, DEST)).toEqual([null, null]);
    expect(f).not.toHaveBeenCalled();
    expect(routingEnabled()).toBe(false);
  });

  it("ors + key → converts the seconds matrix to minutes per origin", async () => {
    process.env.ROUTING_PROVIDER = "ors";
    process.env.ORS_API_KEY = "k";
    // sources × destinations (1 dest): 600s → 10 min, 1200s → 20 min.
    mockFetch(() => json({ durations: [[600], [1200]] }));
    expect(await durationMatrix(ORIGINS, DEST)).toEqual([10, 20]);
    expect(routingEnabled()).toBe(true);
  });

  it("nulls out only the origins the provider couldn't price", async () => {
    process.env.ROUTING_PROVIDER = "ors";
    process.env.ORS_API_KEY = "k";
    mockFetch(() => json({ durations: [[600], [null]] }));
    expect(await durationMatrix(ORIGINS, DEST)).toEqual([10, null]);
  });

  it("non-OK response → all null (fall back to haversine)", async () => {
    process.env.ROUTING_PROVIDER = "ors";
    process.env.ORS_API_KEY = "k";
    mockFetch(() => json({ error: "rate limited" }, false));
    expect(await durationMatrix(ORIGINS, DEST)).toEqual([null, null]);
  });

  it("thrown/aborted fetch → all null (never throws)", async () => {
    process.env.ROUTING_PROVIDER = "ors";
    process.env.ORS_API_KEY = "k";
    mockFetch(() => {
      throw new Error("network down");
    });
    await expect(durationMatrix(ORIGINS, DEST)).resolves.toEqual([null, null]);
  });

  it("malformed body (no durations array) → all null", async () => {
    process.env.ROUTING_PROVIDER = "ors";
    process.env.ORS_API_KEY = "k";
    mockFetch(() => json({ something: "else" }));
    expect(await durationMatrix(ORIGINS, DEST)).toEqual([null, null]);
  });
});
