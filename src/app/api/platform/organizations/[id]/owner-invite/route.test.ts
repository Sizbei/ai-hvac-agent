import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const isPlatformAdmin = vi.fn();
vi.mock("@/lib/auth/authz", () => ({
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
}));

const isSameOriginRequest = vi.fn();
vi.mock("@/lib/session-csrf", () => ({
  isSameOriginRequest: (...a: unknown[]) => isSameOriginRequest(...a),
}));

const slidingWindow = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: (...a: unknown[]) => slidingWindow(...a),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

const createInvite = vi.fn();
const inviteEmailsLast24h = vi.fn();
const getOwnerInviteTarget = vi.fn();
vi.mock("@/lib/admin/invites", () => ({
  createInvite: (...a: unknown[]) => createInvite(...a),
  inviteEmailsLast24h: (...a: unknown[]) => inviteEmailsLast24h(...a),
  getOwnerInviteTarget: (...a: unknown[]) => getOwnerInviteTarget(...a),
}));

const deliverInvite = vi.fn();
const inviteLink = vi.fn();
vi.mock("@/lib/admin/invite-email", () => ({
  deliverInvite: (...a: unknown[]) => deliverInvite(...a),
  inviteLink: (...a: unknown[]) => inviteLink(...a),
}));

const logAudit = vi.fn();
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

const logError = vi.fn();
vi.mock("@/lib/logger", () => ({ logger: { error: (...a: unknown[]) => logError(...a), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { POST } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "d".repeat(64);
const LINK = `https://canonical.example.com/admin/invite/${TOKEN}`;
const SESSION = {
  userId: "u-1",
  organizationId: "00000000-0000-0000-0000-0000000000ff",
  email: "platform@x.com",
  name: "Platform Admin",
  role: "super_admin" as const,
};
const INVITE = {
  id: "inv-1",
  email: "chick@spears.com",
  role: "admin",
  expiresAt: "2026-11-14T00:00:00.000Z",
  createdAt: "2026-11-11T00:00:00.000Z",
};

function req() {
  return new NextRequest(
    `https://app.example.com/api/platform/organizations/${ORG_ID}/owner-invite`,
    { method: "POST", headers: { origin: "https://app.example.com" } },
  );
}
const ctx = (id = ORG_ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
  isPlatformAdmin.mockReturnValue(true);
  isSameOriginRequest.mockReturnValue(true);
  slidingWindow.mockReturnValue({ allowed: true });
  getOwnerInviteTarget.mockResolvedValue({ name: "Spears Services", ownerEmail: "chick@spears.com" });
  inviteEmailsLast24h.mockResolvedValue(3);
  createInvite.mockResolvedValue({ ok: true, invite: INVITE, token: TOKEN });
  deliverInvite.mockReturnValue({ emailed: true });
  inviteLink.mockReturnValue(LINK);
  logAudit.mockResolvedValue(undefined);
});

describe("POST /api/platform/organizations/[id]/owner-invite", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await POST(req(), ctx())).status).toBe(401);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("403 for a non-platform admin (even a super_admin), before origin and rate limit", async () => {
    isPlatformAdmin.mockReturnValue(false);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    expect(isSameOriginRequest).not.toHaveBeenCalled();
    expect(slidingWindow).not.toHaveBeenCalled();
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("403 for a cross-site Origin", async () => {
    isSameOriginRequest.mockReturnValue(false);
    expect((await POST(req(), ctx())).status).toBe(403);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("429 keyed per platform user", async () => {
    slidingWindow.mockReturnValue({ allowed: false });
    expect((await POST(req(), ctx())).status).toBe(429);
    expect(slidingWindow).toHaveBeenCalledWith("platform:owner-invite:u-1", 30, 60_000);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("400 INVALID_ID for a non-UUID id", async () => {
    const res = await POST(req(), ctx("nope"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
    expect(getOwnerInviteTarget).not.toHaveBeenCalled();
  });

  it("404 NOT_FOUND for an unknown org", async () => {
    getOwnerInviteTarget.mockResolvedValue(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("404 NO_OWNER_EMAIL when the org has no owner email", async () => {
    getOwnerInviteTarget.mockResolvedValue({ name: "Spears Services", ownerEmail: null });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NO_OWNER_EMAIL");
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("issues an admin invite to owner_email with the platform admin as actor, and emails it", async () => {
    const res = await POST(req(), ctx());
    expect(res.status).toBe(201);
    expect(createInvite).toHaveBeenCalledWith(
      ORG_ID,
      { email: "chick@spears.com", role: "admin" },
      SESSION,
    );
    expect(inviteEmailsLast24h).toHaveBeenCalledWith(ORG_ID);
    expect(inviteEmailsLast24h.mock.invocationCallOrder[0]).toBeLessThan(
      createInvite.mock.invocationCallOrder[0],
    );
    expect(deliverInvite).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      email: "chick@spears.com",
      orgName: "Spears Services",
      token: TOKEN,
      role: "admin",
      expiresAt: new Date(INVITE.expiresAt),
      priorCount: 3,
    });
    const json = await res.json();
    // Controller ruling: the platform admin ALWAYS gets the copy link.
    expect(json.data).toEqual({ emailed: true, url: LINK });
  });

  it("re-sends after the previous owner invite expired (createInvite clears the stale slot)", async () => {
    // createInvite revokes an expired pending invite itself; the route just
    // succeeds instead of 409/500.
    createInvite.mockResolvedValue({ ok: true, invite: { ...INVITE, id: "inv-2" }, token: TOKEN });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(201);
    expect(logAudit.mock.calls[0][0].entityId).toBe("inv-2");
  });

  it("returns the copy link when not emailed", async () => {
    deliverInvite.mockReturnValue({ emailed: false });
    const json = await (await POST(req(), ctx())).json();
    expect(json.data).toEqual({ emailed: false, url: LINK });
    expect(inviteLink).toHaveBeenCalledWith(TOKEN);
  });

  it("omits url when no app URL is configured", async () => {
    deliverInvite.mockReturnValue({ emailed: false });
    inviteLink.mockReturnValue(null);
    const json = await (await POST(req(), ctx())).json();
    expect(json.data).toEqual({ emailed: false });
  });

  it("audits in the target org with ids, enums and booleans only", async () => {
    await POST(req(), ctx());
    expect(logAudit).toHaveBeenCalledTimes(1);
    const arg = logAudit.mock.calls[0][0];
    expect(arg).toMatchObject({
      organizationId: ORG_ID,
      userId: "u-1",
      action: "create_invite",
      entity: "staff_invite",
      entityId: "inv-1",
    });
    expect(JSON.parse(arg.details)).toEqual({ role: "admin", ownerInvite: true, emailed: true });
    const all = JSON.stringify(arg);
    expect(all).not.toContain("chick@spears.com");
    expect(all).not.toContain(TOKEN);
  });

  it.each([
    ["invite_exists", 409, "INVITE_EXISTS"],
    ["email_conflict", 409, "EMAIL_CONFLICT"],
    ["forbidden", 403, "FORBIDDEN"],
    ["platform_protected", 403, "PLATFORM_PROTECTED"],
    ["seat_limit", 403, "SEAT_LIMIT_REACHED"],
  ])("maps %s → %i %s and sends nothing", async (reason, status, code) => {
    createInvite.mockResolvedValue({ ok: false, reason });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
    expect(deliverInvite).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("500 without leaking the error message or logging the email", async () => {
    createInvite.mockRejectedValue(new Error("secret db detail chick@spears.com"));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
    expect(logError).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logError.mock.calls[0])).not.toContain("chick@spears.com");
  });
});
