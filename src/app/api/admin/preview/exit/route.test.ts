import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const isSameOriginRequest = vi.fn();
vi.mock("@/lib/session-csrf", () => ({
  isSameOriginRequest: (...a: unknown[]) => isSameOriginRequest(...a),
}));

const recordPreviewAudit = vi.fn();
vi.mock("@/lib/admin/preview-targets", () => ({
  recordPreviewAudit: (...a: unknown[]) => recordPreviewAudit(...a),
}));

const logError = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => logError(...a), info: vi.fn() },
}));

import { NextRequest } from "next/server";
import { POST } from "./route";
import { PREVIEW_COOKIE, signPreviewCookie } from "@/lib/auth/preview-cookie";

const SECRET = "e".repeat(48);
const TARGET = "22222222-2222-4222-8222-222222222222";
const SESSION = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "00000000-0000-0000-0000-000000000001",
  email: "owner@platform.test",
  name: "Platform Owner",
  role: "super_admin" as const,
};

function req(cookie?: string) {
  const headers: Record<string, string> = { origin: "https://app.example.com" };
  if (cookie !== undefined) headers.cookie = `${PREVIEW_COOKIE}=${cookie}`;
  return new NextRequest("https://app.example.com/api/admin/preview/exit", {
    method: "POST",
    headers,
  });
}

async function liveCookie(adminUserId = SESSION.userId) {
  return signPreviewCookie(
    { adminUserId, targetUserId: TARGET, exp: Math.floor(Date.now() / 1000) + 600 },
    SECRET,
  );
}

function expectCleared(res: Response) {
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/^hvac_preview=;/);
  expect(setCookie).toMatch(/Max-Age=0/);
  expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  expect(setCookie).toMatch(/Path=\//);
}

beforeAll(() => {
  process.env.AUTH_SECRET = SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
  isSameOriginRequest.mockReturnValue(true);
  recordPreviewAudit.mockResolvedValue(undefined);
});

describe("POST /api/admin/preview/exit", () => {
  it("exit clears the cookie and writes preview_exit", async () => {
    const res = await POST(req(await liveCookie()));
    expect(res.status).toBe(204);
    expectCleared(res);
    expect(recordPreviewAudit).toHaveBeenCalledWith({
      action: "preview_exit",
      session: SESSION,
      targetUserId: TARGET,
    });
  });

  it("clears without an audit row when there is no cookie", async () => {
    const res = await POST(req());
    expect(res.status).toBe(204);
    expectCleared(res);
    expect(recordPreviewAudit).not.toHaveBeenCalled();
  });

  it("clears without an audit row when the cookie is bound to someone else", async () => {
    const res = await POST(req(await liveCookie("99999999-9999-4999-8999-999999999999")));
    expect(res.status).toBe(204);
    expectCleared(res);
    expect(recordPreviewAudit).not.toHaveBeenCalled();
  });

  it("clears without an audit row when the cookie is garbage", async () => {
    const res = await POST(req("garbage"));
    expect(res.status).toBe(204);
    expectCleared(res);
    expect(recordPreviewAudit).not.toHaveBeenCalled();
  });

  it("still clears when there is no session (no audit row)", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await POST(req(await liveCookie()));
    expect(res.status).toBe(204);
    expectCleared(res);
    expect(recordPreviewAudit).not.toHaveBeenCalled();
  });

  it("still clears when the audit write fails", async () => {
    recordPreviewAudit.mockRejectedValue(new Error("db down"));
    const res = await POST(req(await liveCookie()));
    expect(res.status).toBe(204);
    expectCleared(res);
    expect(logError).toHaveBeenCalled();
  });

  it("403 when Origin is cross-site, cookie left alone", async () => {
    isSameOriginRequest.mockReturnValue(false);
    const res = await POST(req(await liveCookie()));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(recordPreviewAudit).not.toHaveBeenCalled();
  });
});
