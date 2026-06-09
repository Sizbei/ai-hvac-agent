import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Hoisted mocks ---
const {
  mockGetSessionToken,
  mockGetOpenAvailability,
  mockSlidingWindow,
  mockIsSameOrigin,
  selectResult,
} = vi.hoisted(() => ({
  mockGetSessionToken: vi.fn(),
  mockGetOpenAvailability: vi.fn(),
  mockSlidingWindow: vi.fn(),
  mockIsSameOrigin: vi.fn(),
  selectResult: { rows: [] as unknown[] },
}));

vi.mock("@/lib/session", () => ({
  getSessionToken: () => mockGetSessionToken(),
}));

// Minimal chainable db.select() returning the staged session row.
vi.mock("@/lib/db", () => ({
  db: {
    select: () => {
      const p: unknown = new Proxy(() => {}, {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => void) => resolve(selectResult.rows);
          }
          return () => p;
        },
        apply: () => p,
      });
      return p;
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  customerSessions: { token: "cs.token", organizationId: "cs.org" },
}));

vi.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => ["eq", ...a] }));

// Fully mock the query layer: the route only needs these four exports, and
// importing the real module would pull the whole scheduling-source → schema
// chain into this route-level test. The pure helpers are covered by
// availability-queries.test.ts; here we stub them deterministically.
vi.mock("@/lib/admin/availability-queries", () => ({
  getOpenAvailability: (...args: unknown[]) => mockGetOpenAvailability(...args),
  businessDaysFrom: (start: string, count: number) =>
    Array.from({ length: count }, (_v, i) => `day-${start}-${i}`),
  businessTodayIso: () => "2026-07-01",
  AVAILABILITY_TIME_ZONE: "America/New_York",
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: (...args: unknown[]) => mockSlidingWindow(...args),
  RATE_LIMITS: { sessionAction: { maxRequests: 10, windowMs: 60_000 } },
}));

vi.mock("@/lib/session-csrf", () => ({
  isSameOriginRequest: (...args: unknown[]) => mockIsSameOrigin(...args),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/availability/route";

function req(opts: { url?: string; origin?: string } = {}): NextRequest {
  const url = new URL(opts.url ?? "http://localhost:3000/api/availability");
  const headers: Record<string, string> = {};
  if (opts.origin) headers["origin"] = opts.origin;
  return new NextRequest(url, { method: "GET", headers });
}

beforeEach(() => {
  vi.clearAllMocks();
  selectResult.rows = [];
  mockSlidingWindow.mockReturnValue({ allowed: true, remaining: 9, resetMs: 0 });
  mockIsSameOrigin.mockReturnValue(true);
});

describe("GET /api/availability — authz", () => {
  it("429s when rate-limited", async () => {
    mockSlidingWindow.mockReturnValue({ allowed: false, remaining: 0, resetMs: 1000 });
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(429);
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("401s with no session token", async () => {
    mockGetSessionToken.mockResolvedValue(null);
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.error.code).toBe("NO_SESSION");
  });

  it("404s when the session token resolves to no session", async () => {
    mockGetSessionToken.mockResolvedValue("tok");
    selectResult.rows = [];
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("SESSION_NOT_FOUND");
  });
});

describe("GET /api/availability — CSRF (GET semantics)", () => {
  it("403s a PRESENT cross-origin Origin header", async () => {
    mockGetSessionToken.mockResolvedValue("tok");
    selectResult.rows = [{ organizationId: "org-1" }];
    mockIsSameOrigin.mockReturnValue(false);
    const res = await GET(req({ origin: "https://evil.example" }));
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN_ORIGIN");
  });

  it("ALLOWS a request with NO Origin header (same-origin GET may omit it)", async () => {
    mockGetSessionToken.mockResolvedValue("tok");
    selectResult.rows = [{ organizationId: "org-1" }];
    mockGetOpenAvailability.mockResolvedValue({ days: ["2026-07-01"], windows: [] });
    const res = await GET(req()); // no origin header
    expect(res.status).toBe(200);
    // isSameOriginRequest is never consulted when Origin is absent.
    expect(mockIsSameOrigin).not.toHaveBeenCalled();
  });
});

describe("GET /api/availability — validation", () => {
  beforeEach(() => {
    mockGetSessionToken.mockResolvedValue("tok");
    selectResult.rows = [{ organizationId: "org-1" }];
  });

  it("400s a malformed start date", async () => {
    const res = await GET(req({ url: "http://localhost:3000/api/availability?start=07-01-2026" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("400s a day count over the max", async () => {
    const res = await GET(req({ url: "http://localhost:3000/api/availability?days=99" }));
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_FAILED");
  });

  it("400s a non-numeric day count", async () => {
    const res = await GET(req({ url: "http://localhost:3000/api/availability?days=abc" }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/availability — success + PII", () => {
  beforeEach(() => {
    mockGetSessionToken.mockResolvedValue("tok");
    selectResult.rows = [{ organizationId: "org-1" }];
  });

  it("returns counts + a fixed business timezone, scoped to the session org", async () => {
    mockGetOpenAvailability.mockResolvedValue({
      days: ["2026-07-01"],
      windows: [
        { day: "2026-07-01", window: "morning", capacity: 2, available: 1 },
      ],
    });
    const res = await GET(req({ url: "http://localhost:3000/api/availability?start=2026-07-01&days=1" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.timeZone).toBe("America/New_York");
    expect(body.data.windows[0]).toEqual({
      day: "2026-07-01",
      window: "morning",
      capacity: 2,
      available: 1,
    });
    // Org came from the session row, not the client; days come from the
    // (stubbed) business-day expansion of start=2026-07-01, count=1.
    expect(mockGetOpenAvailability).toHaveBeenCalledWith("org-1", [
      "day-2026-07-01-0",
    ]);
    // No technician identity anywhere in the payload.
    expect(JSON.stringify(body)).not.toMatch(/technician|assignedTo|tech-/i);
  });

  it("500s gracefully when computation throws", async () => {
    mockGetOpenAvailability.mockRejectedValue(new Error("boom"));
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});
