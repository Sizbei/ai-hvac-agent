import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/** POST /api/admin/customers/[id]/membership — the card gate on chargeFirstPeriod (spec §5.7). */

const { mockGetAdminSession, mockGetCustomerById, mockEnrollCustomer, mockCardPaymentsEnabled } = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockGetCustomerById: vi.fn(),
  mockEnrollCustomer: vi.fn(),
  mockCardPaymentsEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({ getAdminSession: () => mockGetAdminSession() }));
// The route reads the viewer; derive it from the session mock (an org user).
vi.mock("@/lib/auth/viewer", () => ({
  getViewerContext: async () => {
    const session = await mockGetAdminSession();
    return session ? { session, showHidden: false } : null;
  },
}));
vi.mock("@/lib/admin/crm-queries", () => ({ getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a) }));
vi.mock("@/lib/admin/membership-queries", () => ({
  enrollCustomer: (...a: unknown[]) => mockEnrollCustomer(...a),
  cancelMembership: vi.fn(),
  getActiveMembership: vi.fn(),
}));
vi.mock("@/lib/admin/membership-visit-queries", () => ({ listVisitsForMembership: vi.fn() }));
vi.mock("@/lib/payments/card-enabled", () => ({ cardPaymentsEnabled: () => mockCardPaymentsEnabled() }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: { adminMutation: { maxRequests: 100, windowMs: 60000 }, adminRead: { maxRequests: 100, windowMs: 60000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { POST } from "@/app/api/admin/customers/[id]/membership/route";

const ORG = "00000000-0000-0000-0000-000000000001";
const CUST = "eeeeeeee-0000-0000-0000-000000000001";
const PLAN = "ffffffff-0000-4000-8000-000000000001";

function enroll(body: unknown) {
  return POST(
    new NextRequest(`http://localhost:3000/api/admin/customers/${CUST}/membership`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: CUST }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAdminSession.mockResolvedValue({ userId: "u1", organizationId: ORG, role: "admin" });
  mockGetCustomerById.mockResolvedValue({ id: CUST });
  mockEnrollCustomer.mockResolvedValue({ ok: true, membershipId: "m1" });
  mockCardPaymentsEnabled.mockReturnValue(false);
});

describe("POST /api/admin/customers/[id]/membership — card gate", () => {
  it("refuses chargeFirstPeriod while card payments are off, before enrolling", async () => {
    const res = await enroll({ planId: PLAN, chargeFirstPeriod: true });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatchObject({
      code: "CARD_PAYMENTS_UNAVAILABLE",
      message: "Online payment isn't available yet.",
    });
    expect(mockEnrollCustomer).not.toHaveBeenCalled();
  });

  it("enrolls without a charge while card payments are off", async () => {
    const res = await enroll({ planId: PLAN });
    expect(res.status).toBe(201);
    expect(mockEnrollCustomer).toHaveBeenCalledWith(ORG, CUST, PLAN, { chargeFirstPeriod: undefined });
  });

  it("allows chargeFirstPeriod once card payments are on", async () => {
    mockCardPaymentsEnabled.mockReturnValue(true);
    const res = await enroll({ planId: PLAN, chargeFirstPeriod: true });
    expect(res.status).toBe(201);
    expect(mockEnrollCustomer).toHaveBeenCalledWith(ORG, CUST, PLAN, { chargeFirstPeriod: true });
  });
});
