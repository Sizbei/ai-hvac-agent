import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const createInvite = vi.fn();
const listInvites = vi.fn();
vi.mock("@/lib/admin/invites", () => ({
  createInvite: (...a: unknown[]) => createInvite(...a),
  listInvites: (...a: unknown[]) => listInvites(...a),
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

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { NextRequest } from "next/server";
import { POST, GET } from "./route";

const SESSION = {
  userId: "11111111-1111-1111-1111-111111111111",
  organizationId: "00000000-0000-0000-0000-000000000001",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

function postReq(body: unknown) {
  // A real NextRequest so the route can read request.nextUrl.origin.
  return new NextRequest("https://app.example.com/api/admin/invites", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getAdminSession.mockReset();
  createInvite.mockReset();
  listInvites.mockReset();
  logAudit.mockClear();
});

describe("POST /api/admin/invites", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await POST(postReq({ email: "a@x.com", role: "technician" }));
    expect(res.status).toBe(401);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("passes the REAL session.role + userId as actor (no escalation via default)", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createInvite.mockResolvedValue({
      ok: true,
      invite: {
        id: "inv1",
        email: "a@x.com",
        role: "technician",
        expiresAt: "2026-06-13T00:00:00.000Z",
        createdAt: "2026-06-10T00:00:00.000Z",
      },
      token: "a".repeat(64),
    });

    const res = await POST(postReq({ email: "a@x.com", role: "technician" }));
    expect(res.status).toBe(201);
    expect(createInvite).toHaveBeenCalledWith(
      SESSION.organizationId,
      { email: "a@x.com", role: "technician" },
      "admin", // session.role, NOT the defaulted super_admin
      SESSION.userId,
    );
  });

  it("returns the one-time accept URL built from the request origin", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createInvite.mockResolvedValue({
      ok: true,
      invite: {
        id: "inv1",
        email: "a@x.com",
        role: "technician",
        expiresAt: "2026-06-13T00:00:00.000Z",
        createdAt: "2026-06-10T00:00:00.000Z",
      },
      token: "b".repeat(64),
    });
    const res = await POST(postReq({ email: "a@x.com", role: "technician" }));
    const json = await res.json();
    expect(json.data.url).toBe(
      `https://app.example.com/admin/invite/${"b".repeat(64)}`,
    );
  });

  it("rejects super_admin as a role at the schema (never invitable)", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await POST(postReq({ email: "a@x.com", role: "super_admin" }));
    expect(res.status).toBe(400);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("maps forbidden → 403", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createInvite.mockResolvedValue({ ok: false, reason: "forbidden" });
    const res = await POST(postReq({ email: "a@x.com", role: "admin" }));
    expect(res.status).toBe(403);
  });

  it("maps email_conflict → 409", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createInvite.mockResolvedValue({ ok: false, reason: "email_conflict" });
    const res = await POST(postReq({ email: "a@x.com", role: "technician" }));
    expect(res.status).toBe(409);
  });

  it("maps invite_exists → 409", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createInvite.mockResolvedValue({ ok: false, reason: "invite_exists" });
    const res = await POST(postReq({ email: "a@x.com", role: "technician" }));
    expect(res.status).toBe(409);
  });

  it("audits with role enum only (no email/token in details)", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createInvite.mockResolvedValue({
      ok: true,
      invite: {
        id: "inv1",
        email: "secret@x.com",
        role: "technician",
        expiresAt: "2026-06-13T00:00:00.000Z",
        createdAt: "2026-06-10T00:00:00.000Z",
      },
      token: "c".repeat(64),
    });
    await POST(postReq({ email: "secret@x.com", role: "technician" }));
    const auditArg = logAudit.mock.calls[0][0];
    expect(auditArg.action).toBe("create_invite");
    expect(auditArg.details).toBe(JSON.stringify({ role: "technician" }));
    expect(auditArg.details).not.toContain("secret@x.com");
  });
});

describe("GET /api/admin/invites", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("lists invites for the session org", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    listInvites.mockResolvedValue([{ id: "inv1" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(listInvites).toHaveBeenCalledWith(SESSION.organizationId);
  });
});
