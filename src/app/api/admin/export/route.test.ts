import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const isSuperAdmin = vi.fn();
vi.mock("@/lib/auth/authz", () => ({
  isSuperAdmin: (...a: unknown[]) => isSuperAdmin(...a),
}));

const exportOrganization = vi.fn();
const exportCounts = vi.fn((..._a: unknown[]) => ({ customers: 0 }));
vi.mock("@/lib/admin/export-queries", () => ({
  exportOrganization: (...a: unknown[]) => exportOrganization(...a),
  exportCounts: (...a: unknown[]) => exportCounts(...a),
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 60, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "./route";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "owner@x.com",
  name: "Owner",
  role: "super_admin" as const,
};

function req() {
  return new NextRequest("https://app.example.com/api/admin/export");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/export", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("403 for a non-super_admin (a normal admin)", async () => {
    getAdminSession.mockResolvedValue({ ...SESSION, role: "admin" });
    isSuperAdmin.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(exportOrganization).not.toHaveBeenCalled();
  });

  it("streams a JSON attachment + audits (counts only) for super_admin", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    isSuperAdmin.mockReturnValue(true);
    exportOrganization.mockResolvedValue({ customers: [] });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "org_data_exported" }),
    );
  });
});
