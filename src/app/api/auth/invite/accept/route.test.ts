import { it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const acceptInvite = vi.fn();
vi.mock("@/lib/admin/invites", () => ({
  acceptInvite: (...a: unknown[]) => acceptInvite(...a),
}));

const createAdminSession = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/auth/session", () => ({
  createAdminSession: (...a: unknown[]) => createAdminSession(...a),
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { sessionCreate: { maxRequests: 5, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { POST } from "./route";

const TOKEN = "a".repeat(64);

const SELF_ORIGIN = "https://app.example.com";

function req(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(
    new URL("https://app.example.com/api/auth/invite/accept"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: SELF_ORIGIN,
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  acceptInvite.mockReset();
  createAdminSession.mockClear();
  logAudit.mockClear();
});

it("rejects a malformed token shape generically (no enumeration)", async () => {
  const res = await POST(req({ token: "short", name: "N", password: "password1" }));
  expect(res.status).toBe(400);
  const json = await res.json();
  expect(json.error.code).toBe("INVALID_INVITE");
  expect(acceptInvite).not.toHaveBeenCalled();
});

it("rejects a short password", async () => {
  const res = await POST(req({ token: TOKEN, name: "N", password: "short" }));
  expect(res.status).toBe(400);
  expect(acceptInvite).not.toHaveBeenCalled();
});

it("NEVER takes role from the request body — only token/name/password reach acceptInvite", async () => {
  acceptInvite.mockResolvedValue({
    ok: true,
    accepted: {
      userId: "u1",
      organizationId: "org1",
      email: "a@x.com",
      name: "N",
      role: "technician",
      session: null,
    },
  });
  // Attacker also sends role: super_admin in the body — it must be ignored.
  await POST(
    req({ token: TOKEN, name: "N", password: "password1", role: "super_admin" }),
  );
  expect(acceptInvite).toHaveBeenCalledWith(TOKEN, {
    name: "N",
    password: "password1",
  });
});

it("mints an admin session and redirects to /admin for an admin invite", async () => {
  acceptInvite.mockResolvedValue({
    ok: true,
    accepted: {
      userId: "u1",
      organizationId: "org1",
      email: "a@x.com",
      name: "N",
      role: "admin",
      session: {
        userId: "u1",
        organizationId: "org1",
        email: "a@x.com",
        name: "N",
        role: "admin",
      },
    },
  });
  const res = await POST(req({ token: TOKEN, name: "N", password: "password1" }));
  expect(res.status).toBe(200);
  expect(createAdminSession).toHaveBeenCalledOnce();
  const json = await res.json();
  expect(json.data.redirectTo).toBe("/admin");
  // Audits the account creation with role enum only — no email/name/token.
  const auditArg = logAudit.mock.calls[0][0];
  expect(auditArg.action).toBe("accept_invite");
  expect(auditArg.entity).toBe("user");
  expect(auditArg.details).toBe(JSON.stringify({ role: "admin" }));
});

it("does NOT mint a session for a technician invite; routes to the tech login", async () => {
  acceptInvite.mockResolvedValue({
    ok: true,
    accepted: {
      userId: "u2",
      organizationId: "org1",
      email: "t@x.com",
      name: "T",
      role: "technician",
      session: null,
    },
  });
  const res = await POST(req({ token: TOKEN, name: "T", password: "password1" }));
  expect(res.status).toBe(200);
  expect(createAdminSession).not.toHaveBeenCalled();
  const json = await res.json();
  expect(json.data.redirectTo).toBe("/tech-login");
});

it("collapses every accept failure to one generic 400 (no enumeration)", async () => {
  for (const reason of ["invalid", "email_conflict"]) {
    acceptInvite.mockResolvedValue({ ok: false, reason });
    const res = await POST(req({ token: TOKEN, name: "N", password: "password1" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("INVALID_INVITE");
    expect(createAdminSession).not.toHaveBeenCalled();
    // No account was created → nothing to audit.
    expect(logAudit).not.toHaveBeenCalled();
  }
});

it("rejects a cross-origin request with a 403 before touching acceptInvite", async () => {
  const res = await POST(
    req(
      { token: TOKEN, name: "N", password: "password1" },
      { origin: "https://evil.example" },
    ),
  );
  expect(res.status).toBe(403);
  const json = await res.json();
  expect(json.error.code).toBe("FORBIDDEN_ORIGIN");
  expect(acceptInvite).not.toHaveBeenCalled();
});

it("rejects a request with no Origin header (never a legitimate browser POST)", async () => {
  const res = await POST(
    req({ token: TOKEN, name: "N", password: "password1" }, { origin: "" }),
  );
  expect(res.status).toBe(403);
  expect(acceptInvite).not.toHaveBeenCalled();
});

it("rejects a non-JSON content type (no-preflight form-POST vector)", async () => {
  const res = await POST(
    req(
      { token: TOKEN, name: "N", password: "password1" },
      { "content-type": "text/plain" },
    ),
  );
  expect(res.status).toBe(415);
  expect(acceptInvite).not.toHaveBeenCalled();
});
