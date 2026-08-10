import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 60, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

vi.mock("@/lib/config/business-location", () => ({
  BUSINESS_BASE_LOCATION: {
    name: "Base",
    latitude: 36.3,
    longitude: -82.35,
    serviceRadiusKm: 40,
  },
}));

// decrypt() is content-addressed here: strings prefixed "enc:" decrypt to the
// remainder; a "bad:" prefix simulates a corrupt ciphertext (decrypt throws,
// which safeDecrypt in the route swallows to null).
vi.mock("@/lib/crypto", () => ({
  decrypt: (v: string) => {
    if (v.startsWith("bad:")) throw new Error("decrypt failed");
    return v.replace(/^enc:/, "");
  },
}));

const fetchAddressSuggestions = vi.fn();
vi.mock("@/lib/address/photon", () => ({
  fetchAddressSuggestions: (...a: unknown[]) => fetchAddressSuggestions(...a),
}));

/**
 * A minimal thenable/chainable query-builder stand-in. Every property access
 * returns a function that returns the same chain object (so `.from()`,
 * `.leftJoin()`, `.where()`, `.groupBy()`, `.orderBy()`, `.limit()` etc. all
 * chain freely regardless of which the route calls last), except `.then`,
 * which resolves the chain to the fixed `rows` the test wired up — mirroring
 * how a real drizzle query builder is itself a thenable.
 */
function makeChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {
    then: (resolve: (v: unknown[]) => void) => resolve(rows),
  };
  const proxy = new Proxy(chain, {
    get(target, prop) {
      if (prop === "then") return target.then;
      return () => proxy;
    },
  });
  return proxy;
}

let jobRows: unknown[] = [];
let locRows: unknown[] = [];
let arRows: unknown[] = [];
let selectCallCount = 0;
let selectShouldThrow: Error | null = null;

const dbSelect = vi.fn(() => {
  if (selectShouldThrow) throw selectShouldThrow;
  selectCallCount++;
  // 1st db.select() call in the route builds the jobs query; the 2nd builds
  // the AR query (technicians uses db.selectDistinctOn, a separate mock).
  return makeChain(selectCallCount === 1 ? jobRows : arRows);
});
const dbSelectDistinctOn = vi.fn(() => makeChain(locRows));

vi.mock("@/lib/db", () => ({
  db: {
    select: () => dbSelect(),
    selectDistinctOn: () => dbSelectDistinctOn(),
  },
}));

import { GET } from "./route";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

function job(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "j-1",
    referenceNumber: "REQ-1",
    status: "scheduled",
    urgency: "standard",
    issueType: "no_cool",
    addressEncrypted: "enc:123 Main St",
    arrivalWindowStart: null,
    technicianName: null,
    customerNameEncrypted: "enc:Jane Doe",
    customerNameFromCustomer: null,
    priceCents: null,
    cachedLat: null,
    cachedLon: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  jobRows = [];
  locRows = [];
  arRows = [];
  selectCallCount = 0;
  selectShouldThrow = null;
  fetchAddressSuggestions.mockReset();
  getAdminSession.mockResolvedValue(SESSION);
});

describe("GET /api/admin/dispatch/map", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("notPlottedCount is 0 when every job has cached coordinates", async () => {
    jobRows = [job({ cachedLat: 36.3, cachedLon: -82.35 })];
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.jobs).toHaveLength(1);
    expect(body.data.notPlottedCount).toBe(0);
    expect(body.data.geocodeCapped).toBe(false);
  });

  it("counts a job that fails live geocoding (no Photon hit) as not-plotted, under the cap", async () => {
    jobRows = [job({ id: "j-1", cachedLat: null, cachedLon: null })];
    fetchAddressSuggestions.mockResolvedValue([]); // no hit
    const res = await GET();
    const body = await res.json();
    expect(body.data.jobs).toHaveLength(0);
    expect(body.data.notPlottedCount).toBe(1);
    expect(body.data.geocodeCapped).toBe(false);
  });

  it("counts a job whose address fails to decrypt as not-plotted", async () => {
    jobRows = [
      job({ id: "j-1", cachedLat: null, cachedLon: null, addressEncrypted: "bad:corrupt" }),
    ];
    const res = await GET();
    const body = await res.json();
    expect(body.data.jobs).toHaveLength(0);
    expect(body.data.notPlottedCount).toBe(1);
    // Corrupt ciphertext never reaches fetchAddressSuggestions.
    expect(fetchAddressSuggestions).not.toHaveBeenCalled();
  });

  it("notPlottedCount equals M even when M is well under MAX_GEOCODE (25) — not just when the cap is exceeded", async () => {
    // 5 jobs need geocoding; 3 succeed, 2 fail. None of this comes close to
    // the 25-job cap, so geocodeCapped must stay false while notPlottedCount
    // still surfaces the 2 dropped jobs.
    jobRows = [
      job({ id: "j-1", cachedLat: null, cachedLon: null }),
      job({ id: "j-2", cachedLat: null, cachedLon: null }),
      job({ id: "j-3", cachedLat: null, cachedLon: null }),
      job({ id: "j-4", cachedLat: null, cachedLon: null }),
      job({ id: "j-5", cachedLat: null, cachedLon: null }),
    ];
    fetchAddressSuggestions
      .mockResolvedValueOnce([{ lat: 1, lon: 1 }])
      .mockResolvedValueOnce([{ lat: 1, lon: 1 }])
      .mockResolvedValueOnce([{ lat: 1, lon: 1 }])
      .mockResolvedValueOnce([]) // no hit
      .mockResolvedValueOnce([]); // no hit
    const res = await GET();
    const body = await res.json();
    expect(body.data.jobs).toHaveLength(3);
    expect(body.data.notPlottedCount).toBe(2);
    expect(body.data.geocodeCapped).toBe(false);
  });

  it("notPlottedCount reflects every dropped job when the 25-job live-geocode cap is exceeded", async () => {
    // 30 jobs need geocoding: only the first 25 are attempted (all succeed),
    // the remaining 5 are never attempted at all. notPlottedCount must be 5,
    // and geocodeCapped must flip true.
    jobRows = Array.from({ length: 30 }, (_, i) =>
      job({ id: `j-${i}`, cachedLat: null, cachedLon: null }),
    );
    fetchAddressSuggestions.mockResolvedValue([{ lat: 1, lon: 1 }]);
    const res = await GET();
    const body = await res.json();
    expect(fetchAddressSuggestions).toHaveBeenCalledTimes(25);
    expect(body.data.jobs).toHaveLength(25);
    expect(body.data.notPlottedCount).toBe(5);
    expect(body.data.geocodeCapped).toBe(true);
  });

  it("500 when a query throws (never leaks the error)", async () => {
    selectShouldThrow = new Error("db down");
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
