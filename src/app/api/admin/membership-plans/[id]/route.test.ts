import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const getMembershipPlanById = vi.fn();
const updateMembershipPlan = vi.fn();
const deactivateMembershipPlan = vi.fn();
vi.mock("@/lib/admin/membership-queries", () => ({
  getMembershipPlanById: (...a: unknown[]) => getMembershipPlanById(...a),
  updateMembershipPlan: (...a: unknown[]) => updateMembershipPlan(...a),
  deactivateMembershipPlan: (...a: unknown[]) => deactivateMembershipPlan(...a),
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: {
    adminRead: { maxRequests: 60, windowMs: 60_000 },
    adminMutation: { maxRequests: 30, windowMs: 60_000 },
  },
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { PATCH } from "./route";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

const PLAN_ID = "11111111-1111-1111-1111-111111111111";

const EXISTING_PLAN = {
  id: PLAN_ID,
  name: "Comfort Club",
  description: null,
  priceCents: 1999,
  billingPeriod: "monthly",
  visitsPerYear: 2,
  active: false,
};

function patchReq(body: unknown) {
  return new NextRequest(
    `https://app.example.com/api/admin/membership-plans/${PLAN_ID}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: PLAN_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
  getMembershipPlanById.mockResolvedValue(EXISTING_PLAN);
  updateMembershipPlan.mockResolvedValue(undefined);
});

describe("PATCH /api/admin/membership-plans/[id]", () => {
  it("rejects priceCents above MAX_PRICE_CENTS (Rmembership-plans-2)", async () => {
    const res = await PATCH(
      patchReq({ priceCents: 100_000_000 }),
      ctx(),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(updateMembershipPlan).not.toHaveBeenCalled();
  });

  it("accepts priceCents at exactly MAX_PRICE_CENTS", async () => {
    const res = await PATCH(
      patchReq({ priceCents: 99_999_999 }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(updateMembershipPlan).toHaveBeenCalledWith(
      "org-1",
      PLAN_ID,
      expect.objectContaining({ priceCents: 99_999_999 }),
    );
  });

  it("reactivates a plan via { active: true } and logs a dedicated audit action", async () => {
    const res = await PATCH(patchReq({ active: true }), ctx());
    expect(res.status).toBe(200);
    expect(updateMembershipPlan).toHaveBeenCalledWith(
      "org-1",
      PLAN_ID,
      expect.objectContaining({ active: true }),
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "reactivate_membership_plan" }),
    );
  });

  it("rejects active: false — deactivation stays the DELETE endpoint's job", async () => {
    const res = await PATCH(patchReq({ active: false }), ctx());
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(updateMembershipPlan).not.toHaveBeenCalled();
  });
});
