import { describe, it, expect, vi, beforeEach } from "vitest";

// The route imports isSuperAdmin from authz, whose chain pulls `server-only`.
vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const deleteCustomer = vi.fn();
vi.mock("@/lib/admin/crm-queries", () => ({
  getCustomerById: vi.fn(),
  addEquipment: vi.fn(),
  addNote: vi.fn(),
  addFollowUp: vi.fn(),
  updateCustomerContact: vi.fn(),
  completeFollowUp: vi.fn(),
  deleteCustomer: (...a: unknown[]) => deleteCustomer(...a),
  archiveCustomer: vi.fn(),
}));

vi.mock("@/lib/admin/crm-equipment-queries", () => ({
  updateEquipment: vi.fn(),
  deleteEquipment: vi.fn(),
  isEquipmentType: vi.fn(),
}));

vi.mock("@/lib/validation/uuid", () => ({
  isUuid: (v: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
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
import { DELETE } from "./route";

const CUST_ID = "22222222-2222-2222-2222-222222222222";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "owner@x.com",
  name: "Owner",
  role: "super_admin" as const,
};

const ADMIN_SESSION = {
  ...SESSION,
  email: "admin@x.com",
  role: "admin" as const,
};

function deleteReq() {
  return new NextRequest(
    `https://app.example.com/api/admin/customers/${CUST_ID}`,
    { method: "DELETE" },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: CUST_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DELETE /api/admin/customers/[id]", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(401);
    expect(deleteCustomer).not.toHaveBeenCalled();
  });

  it("403 for a non-super admin (hard delete is more destructive than GDPR erase, so it must match its privilege level)", async () => {
    getAdminSession.mockResolvedValue(ADMIN_SESSION);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(deleteCustomer).not.toHaveBeenCalled();
  });

  it("deletes (tenant-scoped) for a super admin in their own org", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    deleteCustomer.mockResolvedValue(true);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(200);
    expect(deleteCustomer).toHaveBeenCalledWith(
      "org-1",
      CUST_ID,
      expect.objectContaining({ userId: "u-1" }),
    );
  });

  it("404 when the customer does not exist in the org", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    deleteCustomer.mockResolvedValue(false);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(404);
  });
});
