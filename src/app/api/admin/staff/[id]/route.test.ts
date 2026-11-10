import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const updateStaff = vi.fn();
const isStaffActive = vi.fn();
vi.mock("@/lib/admin/staff-queries", () => ({
  updateStaff: (...a: unknown[]) => updateStaff(...a),
  isStaffActive: (...a: unknown[]) => isStaffActive(...a),
}));

const getSeatUsage = vi.fn();
vi.mock("@/lib/admin/seats", () => ({
  getSeatUsage: (...a: unknown[]) => getSeatUsage(...a),
}));

vi.mock("@/lib/admin/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { PATCH } from "./route";

const SESSION = {
  userId: "11111111-1111-1111-1111-111111111111",
  organizationId: "00000000-0000-0000-0000-000000000009",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};
const TARGET = "22222222-2222-2222-2222-222222222222";

function patch(body: unknown) {
  return PATCH(
    new NextRequest(`https://app.example.com/api/admin/staff/${TARGET}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TARGET }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
  updateStaff.mockResolvedValue({ ok: true, staff: { id: TARGET } });
});

describe("PATCH /api/admin/staff/[id] reactivation seat gate", () => {
  it("refuses to reactivate an inactive user when the plan is full", async () => {
    isStaffActive.mockResolvedValue(false);
    getSeatUsage.mockResolvedValue({ used: 3, limit: 2 });
    const res = await patch({ name: "Ux Tester", isActive: true });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("SEAT_LIMIT_REACHED");
    expect(updateStaff).not.toHaveBeenCalled();
    expect(isStaffActive).toHaveBeenCalledWith(SESSION.organizationId, TARGET);
    expect(getSeatUsage).toHaveBeenCalledWith(SESSION.organizationId);
  });

  it("reactivates when a seat is free", async () => {
    isStaffActive.mockResolvedValue(false);
    getSeatUsage.mockResolvedValue({ used: 1, limit: 2 });
    const res = await patch({ isActive: true });
    expect(res.status).toBe(200);
    expect(updateStaff).toHaveBeenCalledOnce();
  });

  it("lets an already-active user be edited even when the org is over its limit", async () => {
    isStaffActive.mockResolvedValue(true);
    getSeatUsage.mockResolvedValue({ used: 3, limit: 2 });
    const res = await patch({ name: "Renamed", isActive: true });
    expect(res.status).toBe(200);
    expect(updateStaff).toHaveBeenCalledOnce();
  });

  it("does not check seats for a deactivation or a plain edit", async () => {
    await patch({ isActive: false });
    await patch({ name: "Renamed" });
    expect(isStaffActive).not.toHaveBeenCalled();
    expect(getSeatUsage).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/staff/[id] actor", () => {
  it("passes the whole session as the actor", async () => {
    await patch({ name: "Renamed" });
    expect(updateStaff).toHaveBeenCalledWith(
      SESSION.organizationId,
      TARGET,
      { name: "Renamed" },
      SESSION,
    );
  });

  it("maps a role refusal to 403 FORBIDDEN", async () => {
    updateStaff.mockResolvedValue({ ok: false, reason: "forbidden" });
    const res = await patch({ name: "Renamed" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("maps a platform admin target to 403 PLATFORM_PROTECTED with owner copy", async () => {
    updateStaff.mockResolvedValue({ ok: false, reason: "platform_protected" });
    const res = await patch({ name: "Renamed" });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("PLATFORM_PROTECTED");
    expect(json.error.message).toBe(
      "This account is managed by the platform owner and can’t be changed here.",
    );
  });
});
