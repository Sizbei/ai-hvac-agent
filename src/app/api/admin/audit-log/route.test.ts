import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const getViewerContext = vi.fn();
vi.mock("@/lib/auth/viewer", () => ({ getViewerContext: () => getViewerContext() }));

const getHistoryCutoff = vi.fn();
vi.mock("@/lib/tenancy/features", () => ({
  getHistoryCutoff: (...a: unknown[]) => getHistoryCutoff(...a),
}));

const getAuditLog = vi.fn();
vi.mock("@/lib/admin/audit-queries", () => ({
  getAuditLog: (...a: unknown[]) => getAuditLog(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 100, windowMs: 60_000 } },
}));

const logError = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { error: (...a: unknown[]) => logError(...a) } }));

import { GET } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESSION = { userId: "u-1", organizationId: ORG, role: "super_admin", name: "Chick" };
const CUTOFF = new Date("2026-11-10T17:30:00.000Z");

const req = (qs = "") => new NextRequest(`http://localhost/api/admin/audit-log${qs}`);

beforeEach(() => {
  vi.clearAllMocks();
  getAuditLog.mockResolvedValue({ entries: [], total: 0, actions: [] });
  getHistoryCutoff.mockResolvedValue(CUTOFF);
});

describe("GET /api/admin/audit-log", () => {
  it("401 without a session", async () => {
    getViewerContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
    expect(getAuditLog).not.toHaveBeenCalled();
  });

  it("an org viewer sees entries from the go-live cutoff onward", async () => {
    getViewerContext.mockResolvedValue({ session: SESSION, showHidden: false });
    const res = await GET(req("?action=customer_updated&page=2&limit=20"));
    expect(res.status).toBe(200);
    expect(getHistoryCutoff).toHaveBeenCalledWith(ORG);
    expect(getAuditLog).toHaveBeenCalledWith(ORG, {
      action: "customer_updated",
      entity: undefined,
      page: 2,
      limit: 20,
      since: CUTOFF,
    });
  });

  it("an org viewer with no cutoff recorded gets no bound", async () => {
    getViewerContext.mockResolvedValue({ session: SESSION, showHidden: false });
    getHistoryCutoff.mockResolvedValue(null);
    await GET(req());
    expect(getAuditLog).toHaveBeenCalledWith(ORG, expect.objectContaining({ since: undefined }));
  });

  it("a viewer who sees history (platform admin not previewing) gets every entry", async () => {
    getViewerContext.mockResolvedValue({ session: SESSION, showHidden: true });
    await GET(req());
    expect(getHistoryCutoff).not.toHaveBeenCalled();
    expect(getAuditLog).toHaveBeenCalledWith(ORG, expect.objectContaining({ since: undefined }));
  });

  it("fails closed with a 500 (no entries) when the cutoff can't be read", async () => {
    getViewerContext.mockResolvedValue({ session: SESSION, showHidden: false });
    getHistoryCutoff.mockRejectedValue(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(500);
    expect(getAuditLog).not.toHaveBeenCalled();
    expect(JSON.stringify(await res.json())).not.toContain("db down");
  });
});
