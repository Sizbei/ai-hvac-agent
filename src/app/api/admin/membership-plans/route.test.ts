import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const createMembershipPlan = vi.fn();
const listMembershipPlans = vi.fn();
vi.mock("@/lib/admin/membership-queries", () => ({
  createMembershipPlan: (...a: unknown[]) => createMembershipPlan(...a),
  listMembershipPlans: (...a: unknown[]) => listMembershipPlans(...a),
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
import { POST } from "./route";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

const PLAN_NAME = "Gold Plan — VIP Customer Jane Doe";

function postReq(body: unknown) {
  return new NextRequest("https://app.example.com/api/admin/membership-plans", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/membership-plans", () => {
  it("Gaudit-1: audit details never contain the free-text plan name", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createMembershipPlan.mockResolvedValue("plan-1");

    const res = await POST(
      postReq({
        name: PLAN_NAME,
        priceCents: 1000,
        billingPeriod: "monthly",
      }),
    );
    expect(res.status).toBe(201);

    expect(logAudit).toHaveBeenCalledOnce();
    const call = logAudit.mock.calls[0]![0] as { details: string; entityId: string };
    expect(call.entityId).toBe("plan-1");

    const parsed: unknown = JSON.parse(call.details);
    expect(JSON.stringify(parsed)).not.toContain(PLAN_NAME);
    expect(Object.values(parsed as Record<string, unknown>)).not.toContain(PLAN_NAME);
    expect(parsed).toMatchObject({ billingPeriod: "monthly" });
    expect((parsed as { fields: string[] }).fields).toContain("name");
  });
});
