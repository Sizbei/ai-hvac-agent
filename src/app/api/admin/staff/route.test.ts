import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const getViewerContext = vi.fn();
vi.mock("@/lib/auth/viewer", () => ({
  getViewerContext: () => getViewerContext(),
}));

const listStaff = vi.fn();
const createStaff = vi.fn();
vi.mock("@/lib/admin/staff-queries", () => ({
  listStaff: (...a: unknown[]) => listStaff(...a),
  createStaff: (...a: unknown[]) => createStaff(...a),
}));

const getSeatUsage = vi.fn();
vi.mock("@/lib/admin/seats", () => ({
  getSeatUsage: (...a: unknown[]) => getSeatUsage(...a),
}));

vi.mock("@/lib/admin/audit", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: {
    adminRead: { maxRequests: 60, windowMs: 60_000 },
    adminMutation: { maxRequests: 30, windowMs: 60_000 },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { GET, POST } from "./route";

const SESSION = {
  userId: "11111111-1111-1111-1111-111111111111",
  organizationId: "00000000-0000-0000-0000-000000000009",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

const BODY = { name: "New Tech", email: "new@x.com", password: "longenough", role: "technician" };

function postReq() {
  return new NextRequest("https://app.example.com/api/admin/staff", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(BODY),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
  getViewerContext.mockResolvedValue({ session: SESSION, preview: null });
});

describe("POST /api/admin/staff seat gate", () => {
  it("refuses with SEAT_LIMIT_REACHED when the plan is full, without creating", async () => {
    getSeatUsage.mockResolvedValue({ used: 2, limit: 2 });
    const res = await POST(postReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("SEAT_LIMIT_REACHED");
    expect(createStaff).not.toHaveBeenCalled();
    expect(getSeatUsage).toHaveBeenCalledWith(SESSION.organizationId);
  });

  it("creates when a seat is free", async () => {
    getSeatUsage.mockResolvedValue({ used: 1, limit: 2 });
    createStaff.mockResolvedValue({ ok: true, staff: { id: "u1", role: "technician" } });
    const res = await POST(postReq());
    expect(res.status).toBe(201);
    expect(createStaff).toHaveBeenCalledOnce();
  });
});

describe("POST /api/admin/staff actor", () => {
  it("passes the whole session as the actor", async () => {
    getSeatUsage.mockResolvedValue({ used: 1, limit: 2 });
    createStaff.mockResolvedValue({ ok: true, staff: { id: "u1", role: "technician" } });
    await POST(postReq());
    expect(createStaff).toHaveBeenCalledWith(
      SESSION.organizationId,
      expect.objectContaining({ email: "new@x.com" }),
      SESSION,
    );
  });

  it("maps a role refusal to 403 FORBIDDEN", async () => {
    getSeatUsage.mockResolvedValue({ used: 1, limit: 2 });
    createStaff.mockResolvedValue({ ok: false, reason: "forbidden" });
    const res = await POST(postReq());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
  });

  it("maps a platform-admin email to 403 PLATFORM_PROTECTED with owner copy", async () => {
    getSeatUsage.mockResolvedValue({ used: 1, limit: 2 });
    createStaff.mockResolvedValue({ ok: false, reason: "platform_protected" });
    const res = await POST(postReq());
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("PLATFORM_PROTECTED");
    expect(json.error.message).toBe(
      "This account is managed by the platform owner and can’t be changed here.",
    );
  });
});

describe("GET /api/admin/staff", () => {
  it("returns seat usage for the session org", async () => {
    listStaff.mockResolvedValue([]);
    getSeatUsage.mockResolvedValue({ used: 3, limit: 2 });
    const body = await (await GET()).json();
    expect(body.data.seats).toEqual({ used: 3, limit: 2 });
    expect(getSeatUsage).toHaveBeenCalledWith(SESSION.organizationId);
  });

  it("401 without a viewer", async () => {
    getViewerContext.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(listStaff).not.toHaveBeenCalled();
  });

  it("marks the session user as \"you\" when not previewing", async () => {
    listStaff.mockResolvedValue([]);
    getSeatUsage.mockResolvedValue({ used: 1, limit: 2 });
    const body = await (await GET()).json();
    expect(body.data.currentUserId).toBe(SESSION.userId);
  });

  it("marks the View as target as \"you\" while previewing (m14)", async () => {
    getViewerContext.mockResolvedValue({
      session: SESSION,
      preview: { status: "active", targetUserId: "t1", targetName: "Chick", targetEmail: "c@x.com", targetRole: "super_admin", exp: 1 },
    });
    listStaff.mockResolvedValue([]);
    getSeatUsage.mockResolvedValue({ used: 1, limit: 2 });
    const body = await (await GET()).json();
    expect(body.data.currentUserId).toBe("t1");
    // The list stays the session org's.
    expect(listStaff).toHaveBeenCalledWith(SESSION.organizationId);
  });
});
