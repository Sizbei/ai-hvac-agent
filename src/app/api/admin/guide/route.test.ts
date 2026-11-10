import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

let viewerValue: unknown = null;
vi.mock("@/lib/auth/viewer", () => ({ getViewerContext: async () => viewerValue }));

const patchAdminGuide = vi.fn();
vi.mock("@/lib/admin/admin-guide-queries", () => ({
  patchAdminGuide: (...a: unknown[]) => patchAdminGuide(...a),
}));

const slidingWindow = vi.fn((..._a: unknown[]) => ({ allowed: true }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: (...a: unknown[]) => slidingWindow(...a),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

const loggerError = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), warn: vi.fn(), info: vi.fn() },
  errorCode: () => "E_TEST",
}));

const logAudit = vi.fn();
vi.mock("@/lib/admin/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

import { NextRequest } from "next/server";
import { PATCH } from "./route";

const ORG = "22222222-2222-2222-2222-222222222222";
const ME = "11111111-1111-1111-1111-111111111111";
const SESSION = { userId: ME, organizationId: ORG, email: "a@x.com", name: "A", role: "admin" as const };
const ORIGIN = "https://app.example.com";

function req(body: unknown, headers: Record<string, string> = { origin: ORIGIN }) {
  return new NextRequest(`${ORIGIN}/api/admin/guide`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  viewerValue = { session: SESSION, preview: null };
  patchAdminGuide.mockReset().mockResolvedValue(undefined);
  slidingWindow.mockReset().mockReturnValue({ allowed: true });
  loggerError.mockReset();
  logAudit.mockReset();
});

describe("PATCH /api/admin/guide", () => {
  it("401 without a session", async () => {
    viewerValue = null;
    const res = await PATCH(req({ dismissWelcome: true }));
    expect(res.status).toBe(401);
    expect(patchAdminGuide).not.toHaveBeenCalled();
  });

  it("403 on a missing or cross-site Origin", async () => {
    expect((await PATCH(req({ dismissWelcome: true }, {}))).status).toBe(403);
    expect((await PATCH(req({ dismissWelcome: true }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(patchAdminGuide).not.toHaveBeenCalled();
  });

  it.each([
    ["an active preview", { status: "active", targetUserId: "t", targetName: "Chick", targetRole: "admin", exp: 1 }, ""],
    ["a stale preview", { status: "stale", exp: 1 }, ""],
    ["an unresolved preview cookie", null, "hvac_preview=x"],
  ])("403 PREVIEW_READ_ONLY with %s, and nothing is written", async (_n, preview, cookie) => {
    viewerValue = { session: SESSION, preview };
    const res = await PATCH(req({ lesson: "requests" }, cookie ? { origin: ORIGIN, cookie } : { origin: ORIGIN }));
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("PREVIEW_READ_ONLY");
    expect(patchAdminGuide).not.toHaveBeenCalled();
  });

  it("429 when rate limited, keyed by the session user, before reading the body", async () => {
    slidingWindow.mockReturnValue({ allowed: false });
    const res = await PATCH(req("{not json"));
    expect(res.status).toBe(429);
    expect(slidingWindow).toHaveBeenCalledWith(`admin:guide-patch:${ME}`, 30, 60_000);
    expect(patchAdminGuide).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["an empty object", {}],
    ["an unknown lesson", { lesson: "map" }],
    ["an extra key", { dismissWelcome: true, userId: "someone-else" }],
    ["dismissWelcome false", { dismissWelcome: false }],
  ])("400 VALIDATION_ERROR on %s", async (_n, body) => {
    const res = await PATCH(req(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(patchAdminGuide).not.toHaveBeenCalled();
  });

  it("204 with no body, writing the session user's own row in the session org", async () => {
    const res = await PATCH(req({ lesson: "schedule", tourCompleted: true }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(patchAdminGuide).toHaveBeenCalledWith(ORG, ME, { lesson: "schedule", tourCompleted: true });
  });

  it("always 204, even when the write matched no row (reveals nothing)", async () => {
    patchAdminGuide.mockResolvedValue(undefined);
    expect((await PATCH(req({ dismissWelcome: true }))).status).toBe(204);
    expect((await PATCH(req({ dismissWelcome: true }))).status).toBe(204);
    expect(patchAdminGuide).toHaveBeenCalledTimes(2);
  });

  it("writes no audit row", async () => {
    await PATCH(req({ dismissWelcome: true }));
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("500 with human copy and no err.message when the write throws", async () => {
    patchAdminGuide.mockRejectedValue(new Error("secret db detail"));
    const res = await PATCH(req({ dismissWelcome: true }));
    expect(res.status).toBe(500);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("secret db detail");
    expect(text).toContain("Couldn’t save your progress. Please try again.");
    expect(loggerError).toHaveBeenCalledTimes(1);
  });
});
