import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

vi.mock("server-only", () => ({}));

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
  RATE_LIMITS: {
    adminMutation: { maxRequests: 30, windowMs: 60_000 },
    adminRead: { maxRequests: 60, windowMs: 60_000 },
  },
}));

const listPreviewTargets = vi.fn();
const findPreviewTarget = vi.fn();
const recordPreviewAudit = vi.fn();
vi.mock("@/lib/admin/preview-targets", () => ({
  listPreviewTargets: (...a: unknown[]) => listPreviewTargets(...a),
  findPreviewTarget: (...a: unknown[]) => findPreviewTarget(...a),
  recordPreviewAudit: (...a: unknown[]) => recordPreviewAudit(...a),
}));

const logError = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => logError(...a), info: vi.fn() },
}));

import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import {
  PREVIEW_COOKIE,
  signPreviewCookie,
  verifyPreviewCookie,
} from "@/lib/auth/preview-cookie";

const SECRET = "r".repeat(48);
const ORG = "00000000-0000-0000-0000-000000000001";
const TARGET = "22222222-2222-4222-8222-222222222222";
const SESSION = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: ORG,
  email: "owner@platform.test",
  name: "Platform Owner",
  role: "super_admin" as const,
};

function postReq(body: unknown, cookie?: string) {
  const headers: Record<string, string> = {
    origin: "https://app.example.com",
    "content-type": "application/json",
  };
  if (cookie) headers.cookie = `${PREVIEW_COOKIE}=${cookie}`;
  return new NextRequest("https://app.example.com/api/admin/preview", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function getReq() {
  return new NextRequest("https://app.example.com/api/admin/preview");
}

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
  isPlatformAdmin.mockReturnValue(true);
  isSameOriginRequest.mockReturnValue(true);
  slidingWindow.mockReturnValue({ allowed: true });
  listPreviewTargets.mockResolvedValue([
    { userId: TARGET, name: "Chick Spears", role: "super_admin" },
  ]);
  findPreviewTarget.mockResolvedValue({ userId: TARGET, name: "Chick Spears", role: "super_admin" });
  recordPreviewAudit.mockResolvedValue(undefined);
});

describe("GET /api/admin/preview", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await GET(getReq())).status).toBe(401);
    expect(listPreviewTargets).not.toHaveBeenCalled();
  });

  it("403 for a super_admin who is not a platform admin", async () => {
    isPlatformAdmin.mockReturnValue(false);
    expect((await GET(getReq())).status).toBe(403);
    expect(listPreviewTargets).not.toHaveBeenCalled();
  });

  it("429 when rate limited", async () => {
    slidingWindow.mockReturnValue({ allowed: false });
    expect((await GET(getReq())).status).toBe(429);
    expect(listPreviewTargets).not.toHaveBeenCalled();
  });

  it("lists the org's active users except the platform admin", async () => {
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { targets: [{ userId: TARGET, name: "Chick Spears", role: "super_admin" }] },
    });
    expect(listPreviewTargets).toHaveBeenCalledWith(ORG, SESSION.userId);
  });

  it("500 without the error text when the lookup fails", async () => {
    listPreviewTargets.mockRejectedValue(new Error("secret db detail"));
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret db detail");
  });
});

describe("POST /api/admin/preview", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await POST(postReq({ userId: TARGET }))).status).toBe(401);
    expect(findPreviewTarget).not.toHaveBeenCalled();
  });

  it("403 for a super_admin who is not a platform admin", async () => {
    isPlatformAdmin.mockReturnValue(false);
    const res = await POST(postReq({ userId: TARGET }));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(findPreviewTarget).not.toHaveBeenCalled();
  });

  it("403 when Origin is cross-site", async () => {
    isSameOriginRequest.mockReturnValue(false);
    const res = await POST(postReq({ userId: TARGET }));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(findPreviewTarget).not.toHaveBeenCalled();
  });

  it("429 when rate limited", async () => {
    slidingWindow.mockReturnValue({ allowed: false });
    expect((await POST(postReq({ userId: TARGET }))).status).toBe(429);
    expect(slidingWindow).toHaveBeenCalledWith(
      `admin:preview-start:${SESSION.userId}`,
      30,
      60_000,
    );
  });

  it("400 for a bad body", async () => {
    for (const body of ["not json", { userId: "nope" }, {}, { userId: TARGET, extra: 1 }]) {
      const res = await POST(postReq(body));
      expect(res.status).toBe(400);
    }
    expect(findPreviewTarget).not.toHaveBeenCalled();
  });

  it("404 for an inactive target and for another org's user", async () => {
    // findPreviewTarget is scoped to the session org and active users, so both
    // an inactive user and another org's user come back as null.
    findPreviewTarget.mockResolvedValue(null);
    const res = await POST(postReq({ userId: TARGET }));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(findPreviewTarget).toHaveBeenCalledWith(ORG, TARGET);
    expect(recordPreviewAudit).not.toHaveBeenCalled();
  });

  it("404 when the target is the platform admin themself", async () => {
    const res = await POST(postReq({ userId: SESSION.userId }));
    expect(res.status).toBe(404);
    expect(findPreviewTarget).not.toHaveBeenCalled();
  });

  it("409 ALREADY_PREVIEWING when a valid bound cookie is present", async () => {
    const live = await signPreviewCookie(
      {
        adminUserId: SESSION.userId,
        targetUserId: TARGET,
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      SECRET,
    );
    const res = await POST(postReq({ userId: TARGET }, live));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("ALREADY_PREVIEWING");
    expect(recordPreviewAudit).not.toHaveBeenCalled();
  });

  it("a stale cookie bound to someone else does not block a new preview", async () => {
    const foreign = await signPreviewCookie(
      {
        adminUserId: "99999999-9999-4999-8999-999999999999",
        targetUserId: TARGET,
        exp: Math.floor(Date.now() / 1000) + 600,
      },
      SECRET,
    );
    expect((await POST(postReq({ userId: TARGET }, foreign))).status).toBe(204);
  });

  it("204 sets hvac_preview HttpOnly SameSite=Strict Max-Age=7200 bound to the admin", async () => {
    const before = Math.floor(Date.now() / 1000);
    const res = await POST(postReq({ userId: TARGET }));
    expect(res.status).toBe(204);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^hvac_preview=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Max-Age=7200/);
    expect(setCookie).toMatch(/Path=\//);

    const value = res.cookies.get(PREVIEW_COOKIE)?.value ?? "";
    const claims = await verifyPreviewCookie(value, SECRET);
    expect(claims).not.toBeNull();
    expect(claims?.adminUserId).toBe(SESSION.userId);
    expect(claims?.targetUserId).toBe(TARGET);
    expect(claims!.exp - before).toBeGreaterThanOrEqual(7199);
    expect(claims!.exp - before).toBeLessThanOrEqual(7201);
  });

  it("writes a preview_start audit row with the target id only", async () => {
    await POST(postReq({ userId: TARGET }));
    expect(recordPreviewAudit).toHaveBeenCalledWith({
      action: "preview_start",
      session: SESSION,
      targetUserId: TARGET,
    });
  });

  it("500 and no cookie when the audit write fails", async () => {
    recordPreviewAudit.mockRejectedValue(new Error("db down"));
    const res = await POST(postReq({ userId: TARGET }));
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(await res.json())).not.toContain("db down");
  });
});
