import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

// after() throws outside a Next request scope; capture it, keep the rest real.
const after = vi.fn();
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (cb: unknown) => after(cb),
}));

// Never send a real email.
const sendEmail = vi.fn().mockResolvedValue({ id: "e1" });
vi.mock("@/lib/communication/resend-adapter", () => ({
  sendEmail: (...a: unknown[]) => sendEmail(...a),
}));

const isPlatformAdmin = vi.fn().mockReturnValue(false);
vi.mock("@/lib/auth/authz", () => ({
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const createInvite = vi.fn();
const listInvites = vi.fn();
const inviteEmailsLast24h = vi.fn();
vi.mock("@/lib/admin/invites", () => ({
  createInvite: (...a: unknown[]) => createInvite(...a),
  listInvites: (...a: unknown[]) => listInvites(...a),
  inviteEmailsLast24h: (...a: unknown[]) => inviteEmailsLast24h(...a),
}));

const loadOrgRow = vi.fn();
vi.mock("@/lib/tenancy/org-row", () => ({
  loadOrgRow: (...a: unknown[]) => loadOrgRow(...a),
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

const logError = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => logError(...a), info: vi.fn() },
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

const ORIGINAL_ENV = {
  key: process.env.RESEND_API_KEY,
  app: process.env.NEXT_PUBLIC_APP_URL,
};
function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  getAdminSession.mockReset();
  createInvite.mockReset();
  listInvites.mockReset();
  logAudit.mockClear();
  after.mockClear();
  sendEmail.mockClear();
  isPlatformAdmin.mockReset().mockReturnValue(false);
  inviteEmailsLast24h.mockReset().mockResolvedValue(0);
  loadOrgRow.mockReset().mockResolvedValue({ name: "Spears Services", status: "active", featureFlags: {} });
  process.env.RESEND_API_KEY = "re_test";
  // Deliberately a DIFFERENT host from the request, to prove the link never
  // comes from the request origin.
  process.env.NEXT_PUBLIC_APP_URL = "https://canonical.example.com";
});
afterEach(() => {
  restoreEnv("RESEND_API_KEY", ORIGINAL_ENV.key);
  restoreEnv("NEXT_PUBLIC_APP_URL", ORIGINAL_ENV.app);
});

const TOKEN = "b".repeat(64);
function okInvite(role: "admin" | "technician" = "technician") {
  return {
    ok: true,
    invite: {
      id: "inv1",
      email: "a@x.com",
      role,
      expiresAt: "2026-06-13T00:00:00.000Z",
      createdAt: "2026-06-10T00:00:00.000Z",
    },
    token: TOKEN,
  };
}

describe("POST /api/admin/invites", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await POST(postReq({ email: "a@x.com", role: "technician" }));
    expect(res.status).toBe(401);
    expect(createInvite).not.toHaveBeenCalled();
  });

  it("passes the REAL session as the actor (no escalation via default)", async () => {
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
      SESSION, // the whole session is the actor (role, userId, email, org)
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

  it("maps platform_protected → 403 PLATFORM_PROTECTED with owner copy", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createInvite.mockResolvedValue({ ok: false, reason: "platform_protected" });
    const res = await POST(postReq({ email: "r@x.com", role: "technician" }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("PLATFORM_PROTECTED");
    expect(json.error.message).toBe(
      "This account is managed by the platform owner and can’t be changed here.",
    );
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
    expect(auditArg.details).toBe(JSON.stringify({ role: "technician", emailed: true }));
    expect(auditArg.details).not.toContain("secret@x.com");
    expect(JSON.stringify(auditArg)).not.toContain("c".repeat(64));
  });

  it("emails in after() and omits url when RESEND_API_KEY is set", async () => {
    getAdminSession.mockResolvedValue({ ...SESSION, role: "super_admin" });
    createInvite.mockResolvedValue(okInvite());
    const res = await POST(postReq({ email: "a@x.com", role: "technician" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.emailed).toBe(true);
    expect(json.data).not.toHaveProperty("url");
    expect(json.data.invite.id).toBe("inv1");
    expect(JSON.stringify(json)).not.toContain(TOKEN);
    expect(after).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
    await (after.mock.calls[0][0] as () => Promise<void>)();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0][0];
    expect(sent.to).toBe("a@x.com");
    expect(sent.subject).toBe("You’re invited to Spears Services");
    expect(sent.html).toContain(`https://canonical.example.com/admin/invite/${TOKEN}`);
  });

  it("returns url and emailed:false without RESEND_API_KEY for a super_admin", async () => {
    delete process.env.RESEND_API_KEY;
    getAdminSession.mockResolvedValue({ ...SESSION, role: "super_admin" });
    createInvite.mockResolvedValue(okInvite());
    const res = await POST(postReq({ email: "a@x.com", role: "technician" }));
    const json = await res.json();
    expect(json.data.emailed).toBe(false);
    expect(json.data.url).toBe(`https://canonical.example.com/admin/invite/${TOKEN}`);
    expect(after).not.toHaveBeenCalled();
  });

  it("returns url without RESEND_API_KEY for a platform admin", async () => {
    delete process.env.RESEND_API_KEY;
    getAdminSession.mockResolvedValue(SESSION);
    isPlatformAdmin.mockReturnValue(true);
    createInvite.mockResolvedValue(okInvite());
    const json = await (await POST(postReq({ email: "a@x.com", role: "technician" }))).json();
    expect(json.data.url).toBe(`https://canonical.example.com/admin/invite/${TOKEN}`);
  });

  it("returns emailed:false and no url for a plain admin without RESEND_API_KEY", async () => {
    delete process.env.RESEND_API_KEY;
    getAdminSession.mockResolvedValue(SESSION); // role admin, not platform
    createInvite.mockResolvedValue(okInvite());
    const res = await POST(postReq({ email: "a@x.com", role: "technician" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.emailed).toBe(false);
    expect(json.data).not.toHaveProperty("url");
    expect(JSON.stringify(json)).not.toContain(TOKEN);
  });

  it("never builds the link from the request origin", async () => {
    delete process.env.RESEND_API_KEY;
    getAdminSession.mockResolvedValue({ ...SESSION, role: "super_admin" });
    createInvite.mockResolvedValue(okInvite());
    let json = await (await POST(postReq({ email: "a@x.com", role: "technician" }))).json();
    expect(json.data.url).not.toContain("app.example.com");

    // No configured app URL → no link at all (not a request-origin fallback).
    delete process.env.NEXT_PUBLIC_APP_URL;
    createInvite.mockResolvedValue(okInvite());
    json = await (await POST(postReq({ email: "a@x.com", role: "technician" }))).json();
    expect(json.data.emailed).toBe(false);
    expect(json.data).not.toHaveProperty("url");
  });

  it("reads the 24 h count BEFORE creating the invite, scoped to the session org", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createInvite.mockResolvedValue(okInvite());
    await POST(postReq({ email: "a@x.com", role: "technician" }));
    expect(inviteEmailsLast24h).toHaveBeenCalledWith(SESSION.organizationId);
    expect(inviteEmailsLast24h.mock.invocationCallOrder[0]).toBeLessThan(
      createInvite.mock.invocationCallOrder[0],
    );
  });

  it("a failed create logs a code and the org id, never the error (it can echo the email)", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createInvite.mockRejectedValue(new Error('duplicate key (email)=(secret@x.com)'));
    logError.mockClear();
    const res = await POST(postReq({ email: "secret@x.com", role: "technician" }));
    expect(res.status).toBe(500);
    expect(logError).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(logError.mock.calls[0]);
    expect(logged).toContain(SESSION.organizationId);
    expect(logged).not.toContain("secret@x.com");
  });

  it("emails the 20th invite of 24h and not the 21st", async () => {
    getAdminSession.mockResolvedValue({ ...SESSION, role: "super_admin" });
    createInvite.mockResolvedValue(okInvite());
    inviteEmailsLast24h.mockResolvedValue(19);
    let json = await (await POST(postReq({ email: "a@x.com", role: "technician" }))).json();
    expect(json.data.emailed).toBe(true);

    createInvite.mockResolvedValue(okInvite());
    inviteEmailsLast24h.mockResolvedValue(20);
    json = await (await POST(postReq({ email: "a@x.com", role: "technician" }))).json();
    expect(json.data.emailed).toBe(false);
    expect(json.data.url).toBe(`https://canonical.example.com/admin/invite/${TOKEN}`);
    expect(after).toHaveBeenCalledTimes(1);
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
