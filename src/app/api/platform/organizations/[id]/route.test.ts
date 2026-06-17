import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const isPlatformAdmin = vi.fn();
vi.mock("@/lib/auth/authz", () => ({
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
}));

const purgeOrganization = vi.fn();
vi.mock("@/lib/admin/erasure-queries", () => ({
  purgeOrganization: (...a: unknown[]) => purgeOrganization(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { DELETE } from "./route";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

const PLATFORM_SESSION = {
  userId: "u-1",
  organizationId: "00000000-0000-0000-0000-000000000001",
  email: "platform@x.com",
  name: "Platform Admin",
  role: "super_admin" as const,
};

function delReq() {
  return new NextRequest(
    `https://app.example.com/api/platform/organizations/${ORG_ID}`,
    { method: "DELETE" },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: ORG_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/platform/organizations/[id] (purge)", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await DELETE(delReq(), ctx());
    expect(res.status).toBe(401);
    expect(purgeOrganization).not.toHaveBeenCalled();
  });

  it("403 for a non-platform admin (an in-org super_admin)", async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(false);
    const res = await DELETE(delReq(), ctx());
    expect(res.status).toBe(403);
    expect(purgeOrganization).not.toHaveBeenCalled();
  });

  it("purges and returns ok for a platform admin", async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(true);
    purgeOrganization.mockResolvedValue(true);
    const res = await DELETE(delReq(), ctx());
    expect(res.status).toBe(200);
    expect(purgeOrganization).toHaveBeenCalledWith(ORG_ID, {
      userId: PLATFORM_SESSION.userId,
      email: PLATFORM_SESSION.email,
    });
  });

  it("404 when the org does not exist", async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(true);
    purgeOrganization.mockResolvedValue(false);
    const res = await DELETE(delReq(), ctx());
    expect(res.status).toBe(404);
  });
});
