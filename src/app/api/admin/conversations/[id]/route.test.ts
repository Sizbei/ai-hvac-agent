import { describe, it, expect, vi, beforeEach } from "vitest";

// The route imports isSuperAdmin from authz, whose chain pulls `server-only`.
vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const getConversationById = vi.fn();
const deleteConversation = vi.fn();
vi.mock("@/lib/admin/conversation-queries", () => ({
  getConversationById: (...a: unknown[]) => getConversationById(...a),
  deleteConversation: (...a: unknown[]) => deleteConversation(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/http/client-ip", () => ({ clientIp: () => "1.2.3.4" }));

import { NextRequest } from "next/server";
import { GET, DELETE } from "./route";

const SESSION_ID = "22222222-2222-2222-2222-222222222222";

const SUPER_ADMIN_SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "owner@x.com",
  name: "Owner",
  role: "super_admin" as const,
};

const ADMIN_SESSION = {
  ...SUPER_ADMIN_SESSION,
  email: "admin@x.com",
  role: "admin" as const,
};

function getReq() {
  return new Request(
    `https://app.example.com/api/admin/conversations/${SESSION_ID}`,
  );
}

function deleteReq() {
  return new NextRequest(
    `https://app.example.com/api/admin/conversations/${SESSION_ID}`,
    { method: "DELETE" },
  );
}

function ctx() {
  return { params: Promise.resolve({ id: SESSION_ID }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/conversations/[id]", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(401);
  });

  it("200 for any authenticated role (read is not role-gated)", async () => {
    getAdminSession.mockResolvedValue(ADMIN_SESSION);
    getConversationById.mockResolvedValue({ id: SESSION_ID });
    const res = await GET(getReq(), ctx());
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/admin/conversations/[id]", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(401);
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it("403 for a non-super admin (permanent delete is destructive, matches other hard-delete routes)", async () => {
    getAdminSession.mockResolvedValue(ADMIN_SESSION);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(deleteConversation).not.toHaveBeenCalled();
  });

  it("deletes (tenant-scoped) for a super admin in their own org", async () => {
    getAdminSession.mockResolvedValue(SUPER_ADMIN_SESSION);
    deleteConversation.mockResolvedValue(true);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(200);
    expect(deleteConversation).toHaveBeenCalledWith(
      SUPER_ADMIN_SESSION.organizationId,
      SESSION_ID,
      { userId: SUPER_ADMIN_SESSION.userId, ipAddress: "1.2.3.4" },
    );
  });

  it("404 when the conversation does not exist", async () => {
    getAdminSession.mockResolvedValue(SUPER_ADMIN_SESSION);
    deleteConversation.mockResolvedValue(false);
    const res = await DELETE(deleteReq(), ctx());
    expect(res.status).toBe(404);
  });
});
