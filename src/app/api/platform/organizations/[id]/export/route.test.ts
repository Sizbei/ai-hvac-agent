import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const isPlatformAdmin = vi.fn();
vi.mock("@/lib/auth/authz", () => ({
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
}));

const exportOrganization = vi.fn();
const exportCounts = vi.fn((..._a: unknown[]) => ({ customers: 0 }));
vi.mock("@/lib/admin/export-queries", () => ({
  exportOrganization: (...a: unknown[]) => exportOrganization(...a),
  exportCounts: (...a: unknown[]) => exportCounts(...a),
}));

const insertValues = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/db", () => ({
  db: { insert: () => ({ values: (...a: unknown[]) => insertValues(...a) }) },
}));
vi.mock("@/lib/db/schema", () => ({ platformAuditLog: { __name: "pal" } }));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 60, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

const PLATFORM_SESSION = {
  userId: "u-1",
  organizationId: "00000000-0000-0000-0000-000000000001",
  email: "platform@x.com",
  name: "Platform Admin",
  role: "super_admin" as const,
};

function req() {
  return new NextRequest(
    `https://app.example.com/api/platform/organizations/${ORG_ID}/export`,
  );
}

function ctx() {
  return { params: Promise.resolve({ id: ORG_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/platform/organizations/[id]/export", () => {
  it("403 for a non-platform admin", async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(false);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(403);
    expect(exportOrganization).not.toHaveBeenCalled();
  });

  it("exports + records platform_audit_log (counts only) for a platform admin", async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(true);
    exportOrganization.mockResolvedValue({ customers: [] });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "org_data_exported",
        targetOrgId: ORG_ID,
      }),
    );
  });

  it("404 when the org does not exist", async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(true);
    exportOrganization.mockResolvedValue(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
  });
});
