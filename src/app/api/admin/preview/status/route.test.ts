import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const getViewerContext = vi.fn();
vi.mock("@/lib/auth/viewer", () => ({ getViewerContext: () => getViewerContext() }));

const slidingWindow = vi.fn();
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: (...a: unknown[]) => slidingWindow(...a),
  RATE_LIMITS: { adminRead: { maxRequests: 60, windowMs: 60_000 } },
}));

const logError = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => logError(...a) },
  errorCode: () => "E",
}));

import { GET } from "./route";

const SESSION = { userId: "u1", organizationId: "o1", email: "a@x.com", name: "A", role: "super_admin" };

beforeEach(() => {
  vi.resetAllMocks();
  slidingWindow.mockReturnValue({ allowed: true });
});

describe("GET /api/admin/preview/status", () => {
  it("401 without a session", async () => {
    getViewerContext.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("not previewing", async () => {
    getViewerContext.mockResolvedValue({ session: SESSION, preview: null });
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ previewing: false, targetUserId: null });
  });

  it("active preview → its target id only", async () => {
    getViewerContext.mockResolvedValue({
      session: SESSION,
      preview: { status: "active", targetUserId: "t1", targetName: "Chick", targetRole: "admin", exp: 9 },
    });
    const json = await (await GET()).json();
    expect(json.data).toEqual({ previewing: true, targetUserId: "t1" });
  });

  it("stale preview → previewing, no target", async () => {
    getViewerContext.mockResolvedValue({ session: SESSION, preview: { status: "stale", exp: 9 } });
    expect((await (await GET()).json()).data).toEqual({ previewing: true, targetUserId: null });
  });

  it("429 when rate limited", async () => {
    getViewerContext.mockResolvedValue({ session: SESSION, preview: null });
    slidingWindow.mockReturnValue({ allowed: false });
    expect((await GET()).status).toBe(429);
  });

  it("500 with generic copy when the viewer throws", async () => {
    getViewerContext.mockRejectedValue(new Error("secret detail"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret detail");
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
