import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const searchAllEntities = vi.fn();
vi.mock("@/lib/admin/search-queries", () => ({
  searchAllEntities: (...a: unknown[]) => searchAllEntities(...a),
}));

const slidingWindow = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: (...a: unknown[]) => slidingWindow(...a),
  RATE_LIMITS: { adminRead: { maxRequests: 60, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { NextRequest } from "next/server";
import { GET } from "./route";

const SESSION = {
  userId: "11111111-1111-1111-1111-111111111111",
  organizationId: "00000000-0000-0000-0000-000000000001",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

function req(search: string) {
  return new NextRequest(
    `https://app.example.com/api/admin/search${search}`,
  );
}

beforeEach(() => {
  getAdminSession.mockReset();
  searchAllEntities.mockReset();
  slidingWindow.mockReturnValue({ allowed: true });
});

describe("GET /api/admin/search", () => {
  it("returns 401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await GET(req("?q=foo"));
    expect(res.status).toBe(401);
    expect(searchAllEntities).not.toHaveBeenCalled();
  });

  it("returns { results: [] } when q is missing", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await GET(req(""));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ results: [] });
    expect(searchAllEntities).not.toHaveBeenCalled();
  });

  it("returns { results: [] } when q.length < 2", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await GET(req("?q=a"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ results: [] });
    expect(searchAllEntities).not.toHaveBeenCalled();
  });

  it("returns { results: [] } when q.length > 100 (bounds the ILIKE pattern)", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await GET(req(`?q=${"a".repeat(101)}`));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ results: [] });
    expect(searchAllEntities).not.toHaveBeenCalled();
  });

  it("returns 429 when rate limit is exceeded", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    slidingWindow.mockReturnValue({ allowed: false });
    const res = await GET(req("?q=foo"));
    expect(res.status).toBe(429);
    expect(searchAllEntities).not.toHaveBeenCalled();
  });

  it("calls searchAllEntities with organizationId and q", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    searchAllEntities.mockResolvedValue([]);
    await GET(req("?q=test"));
    expect(searchAllEntities).toHaveBeenCalledWith(
      SESSION.organizationId,
      "test",
    );
  });

  it("returns grouped results in the response", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const mockResults = [
      {
        type: "customer" as const,
        id: "cust-1",
        title: "John Doe",
        subtitle: "555-1234",
        href: "/admin/customers/cust-1",
        syncedSource: null,
      },
      {
        type: "invoice" as const,
        id: "inv-1",
        title: "#INV00001",
        subtitle: "open · $100.00",
        href: "/admin/invoices/inv-1",
        syncedSource: "fieldpulse" as const,
      },
    ];
    searchAllEntities.mockResolvedValue(mockResults);
    const res = await GET(req("?q=john"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.results).toEqual(mockResults);
  });
});
