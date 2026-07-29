import { describe, it, expect, vi, beforeEach } from "vitest";

// The route imports isSuperAdmin from authz, whose chain pulls `server-only`.
vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const anonymizeCustomer = vi.fn();
vi.mock("@/lib/admin/erasure-queries", () => ({
  anonymizeCustomer: (...a: unknown[]) => anonymizeCustomer(...a),
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "./route";

const CUST_ID = "22222222-2222-2222-2222-222222222222";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "owner@x.com",
  name: "Owner",
  role: "super_admin" as const,
};

const ADMIN_SESSION = { ...SESSION, email: "admin@x.com", role: "admin" as const };

function postReq() {
  return new NextRequest(
    `https://app.example.com/api/admin/customers/${CUST_ID}/erase`,
    { method: "POST" },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: CUST_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/customers/[id]/erase", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(401);
    expect(anonymizeCustomer).not.toHaveBeenCalled();
  });

  it("anonymizes (tenant-scoped) + audits for a super admin in their own org", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    anonymizeCustomer.mockResolvedValue(true);
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(200);
    expect(anonymizeCustomer).toHaveBeenCalledWith("org-1", CUST_ID);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "customer_erased",
        organizationId: "org-1",
        userId: "u-1",
      }),
    );
  });

  it("403 for a non-super admin (owner-tier only; keeps the demo admin out)", async () => {
    getAdminSession.mockResolvedValue(ADMIN_SESSION);
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(403);
    expect(anonymizeCustomer).not.toHaveBeenCalled();
  });

  it("404 when the customer does not exist in the org", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    anonymizeCustomer.mockResolvedValue(false);
    const res = await POST(postReq(), ctx());
    expect(res.status).toBe(404);
  });
});
