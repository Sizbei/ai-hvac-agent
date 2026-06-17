import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

// Real authz so the gate (super_admin || platform admin) is exercised.
vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: {
    adminRead: { maxRequests: 60, windowMs: 60_000 },
    adminMutation: { maxRequests: 30, windowMs: 60_000 },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { db } from "@/lib/db";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

const ORG = "00000000-0000-0000-0000-000000000001";

function session(role: "super_admin" | "admin", email = "u@x.com") {
  return { userId: "u1", organizationId: ORG, email, name: "U", role };
}

function mockOrgSelect(rows: unknown[]) {
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
      }) as never,
  );
}

function postReq(body: unknown) {
  return new NextRequest("https://app.example.com/api/platform/billing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.PLATFORM_ADMIN_EMAILS;
  delete process.env.STRIPE_SECRET_KEY;
});

describe("GET /api/platform/billing", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("403 for a normal admin (not super_admin, not platform admin)", async () => {
    getAdminSession.mockResolvedValue(session("admin"));
    expect((await GET()).status).toBe(403);
  });

  it("200 with plan/status/entitlements for a super_admin", async () => {
    getAdminSession.mockResolvedValue(session("super_admin"));
    mockOrgSelect([{ plan: "pro", status: "active", currentPeriodEnd: null }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.plan.id).toBe("pro");
    expect(json.data.status).toBe("active");
    expect(json.data.active).toBe(true);
    expect(json.data.entitlements.maxStaff).toBe(20);
  });
});

describe("POST /api/platform/billing", () => {
  it("403 for a normal admin", async () => {
    getAdminSession.mockResolvedValue(session("admin"));
    const res = await POST(postReq({ action: "portal" }));
    expect(res.status).toBe(403);
  });

  it("returns a checkout url for a super_admin (mock provider)", async () => {
    getAdminSession.mockResolvedValue(session("super_admin"));
    const res = await POST(postReq({ action: "checkout", planId: "pro" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.url).toContain(`/billing/checkout/${ORG}/pro`);
    expect(logAudit).toHaveBeenCalled();
  });

  it("400 for an unknown plan id", async () => {
    getAdminSession.mockResolvedValue(session("super_admin"));
    const res = await POST(postReq({ action: "checkout", planId: "ghost" }));
    expect(res.status).toBe(400);
  });

  it("returns a portal url for a super_admin", async () => {
    getAdminSession.mockResolvedValue(session("super_admin"));
    const res = await POST(postReq({ action: "portal" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.url).toContain(`/billing/portal/${ORG}`);
  });

  it("allows a platform admin even if only role=admin (env allowlist)", async () => {
    process.env.PLATFORM_ADMIN_EMAILS = "ops@x.com";
    getAdminSession.mockResolvedValue(session("admin", "ops@x.com"));
    const res = await POST(postReq({ action: "portal" }));
    expect(res.status).toBe(200);
  });
});
