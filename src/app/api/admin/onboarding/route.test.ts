import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

// The viewer wraps the same session; `preview` is what a test sets.
let preview: unknown = null;
vi.mock("@/lib/auth/viewer", () => ({
  getViewerContext: async () => {
    const session = await getAdminSession();
    return session ? { session, preview } : null;
  },
}));

const readAdminGuide = vi.fn();
vi.mock("@/lib/admin/admin-guide-queries", () => ({
  readAdminGuide: (...a: unknown[]) => readAdminGuide(...a),
}));

const getOnboarding = vi.fn();
const patchOnboarding = vi.fn();
vi.mock("@/lib/admin/onboarding-queries", () => ({
  getOnboarding: (...a: unknown[]) => getOnboarding(...a),
  patchOnboarding: (...a: unknown[]) => patchOnboarding(...a),
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock("@/lib/auth/google-oidc", () => ({
  getGoogleOidcConfig: () => null,
}));

const slidingWindow = vi.fn(() => ({ allowed: true }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => slidingWindow(),
  RATE_LIMITS: {
    adminRead: { maxRequests: 60, windowMs: 60_000 },
    adminMutation: { maxRequests: 30, windowMs: 60_000 },
  },
}));

const loggerError = vi.fn();
const loggerWarn = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { error: (...a: unknown[]) => loggerError(...a), info: vi.fn(), warn: (...a: unknown[]) => loggerWarn(...a) },
  errorCode: (e: unknown) => (e instanceof Error ? "E_GUIDE" : "unknown"),
}));

import { NextRequest } from "next/server";
import { GET, PATCH } from "./route";
const DEMO_ORG_ID = "33333333-3333-3333-3333-333333333333";

const ORG = "22222222-2222-2222-2222-222222222222";
const SESSION = {
  userId: "11111111-1111-1111-1111-111111111111",
  organizationId: ORG,
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};
const PAYLOAD = { steps: [], progress: { done: 0, total: 0 }, demo: false };
const GUIDE = { welcomeDue: true, lastLesson: null, readOnly: false };

function getReq(cookie?: string) {
  return new NextRequest("https://app.example.com/api/admin/onboarding", {
    headers: cookie ? { cookie } : {},
  });
}

function patchReq(body: unknown) {
  return new NextRequest("https://app.example.com/api/admin/onboarding", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  preview = null;
  process.env.DEMO_MODE_ORG_IDS = DEMO_ORG_ID;
  getAdminSession.mockReset();
  getOnboarding.mockReset().mockResolvedValue(PAYLOAD);
  readAdminGuide.mockReset().mockResolvedValue(GUIDE);
  patchOnboarding.mockReset().mockResolvedValue({ flags: {} });
  logAudit.mockReset().mockResolvedValue(undefined);
  loggerError.mockReset();
  loggerWarn.mockReset();
  slidingWindow.mockReset().mockReturnValue({ allowed: true });
});

describe("GET /api/admin/onboarding", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await GET(getReq());
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("429 when rate limited", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    slidingWindow.mockReturnValue({ allowed: false });
    const res = await GET(getReq());
    expect(res.status).toBe(429);
    expect(getOnboarding).not.toHaveBeenCalled();
  });

  it("returns the payload with no wrapper, demo false for a normal org", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ ...PAYLOAD, guide: GUIDE });
    expect(json.data.onboarding).toBeUndefined();
    expect(getOnboarding).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ demo: false, write: true, googleEnabled: false }),
    );
  });

  it("onboarding GET passes write:false while previewing and never runs the stamp statement", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    preview = { status: "active", targetUserId: "t", targetName: "Chick", targetRole: "admin" };
    const res = await GET(getReq("hvac_preview=signed"));
    expect(res.status).toBe(200);
    expect(getOnboarding).toHaveBeenCalledWith(ORG, expect.objectContaining({ write: false }));
  });

  it("a stale preview is still read-only: write:false", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    preview = { status: "stale" };
    await GET(getReq("hvac_preview=signed"));
    expect(getOnboarding).toHaveBeenCalledWith(ORG, expect.objectContaining({ write: false }));
  });

  it("any preview cookie on the request means write:false, even if the viewer resolved none", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    await GET(getReq("hvac_preview=unresolved"));
    expect(getOnboarding).toHaveBeenCalledWith(ORG, expect.objectContaining({ write: false }));
  });

  it("passes demo:true only when DEMO_MODE_ORG_IDS lists the org", async () => {
    delete process.env.DEMO_MODE_ORG_IDS;
    getAdminSession.mockResolvedValue({ ...SESSION, organizationId: DEMO_ORG_ID });
    await GET(getReq());
    expect(getOnboarding).toHaveBeenCalledWith(
      DEMO_ORG_ID,
      expect.objectContaining({ demo: false }),
    );
  });

  it("passes demo: true for a demo-mode org", async () => {
    getAdminSession.mockResolvedValue({ ...SESSION, organizationId: DEMO_ORG_ID });
    await GET(getReq());
    expect(getOnboarding).toHaveBeenCalledWith(
      DEMO_ORG_ID,
      expect.objectContaining({ demo: true, write: false }),
    );
  });

  it("adds guide from a separate read, read-write for the session user", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    await GET(getReq());
    expect(readAdminGuide).toHaveBeenCalledTimes(1);
    const [viewerArg, opts] = readAdminGuide.mock.calls[0];
    expect((viewerArg as { session: unknown }).session).toEqual(SESSION);
    expect(opts).toEqual({ readOnly: false });
  });

  it.each([
    ["an active preview", { status: "active", targetUserId: "t", targetName: "Chick", targetRole: "admin" }, "hvac_preview=signed"],
    ["a stale preview", { status: "stale" }, "hvac_preview=signed"],
    ["an unresolved preview cookie", null, "hvac_preview=x"],
  ])("guide is readOnly with %s", async (_n, p, cookie) => {
    getAdminSession.mockResolvedValue(SESSION);
    preview = p;
    await GET(getReq(cookie));
    expect(readAdminGuide.mock.calls[0][1]).toEqual({ readOnly: true });
  });

  it("a failed guide read gives guide: null, keeps the checklist and logs a code only", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    readAdminGuide.mockRejectedValue(new Error("secret db detail"));
    const res = await GET(getReq());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ ...PAYLOAD, guide: null });
    const warned = JSON.stringify(loggerWarn.mock.calls);
    expect(warned).toContain("E_GUIDE");
    expect(warned).not.toContain("secret db detail");
  });

  it("500 with generic copy when the query throws", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    getOnboarding.mockRejectedValue(new Error("secret db detail"));
    const res = await GET(getReq());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret db detail");
  });
});

describe("PATCH /api/admin/onboarding", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await PATCH(patchReq({ dismissed: true }));
    expect(res.status).toBe(401);
  });

  it.each([
    ["empty object", {}],
    ["dismissed false", { dismissed: false }],
    ["unknown flag", { flags: { techSignedInAt: "x" } }],
    ["extra top-level key", { dismissed: true, foo: 1 }],
    ["empty flags", { flags: {} }],
    ["embedCopied false", { flags: { embedCopied: false } }],
    ["showOnHome false", { showOnHome: false }],
    ["showOnHome with dismissed", { showOnHome: true, dismissed: true }],
    ["showOnHome with a flag", { showOnHome: true, flags: { embedCopied: true } }],
  ])("400 VALIDATION_ERROR on %s", async (_n, body) => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await PATCH(patchReq(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(patchOnboarding).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await PATCH(patchReq("{not json"));
    expect(res.status).toBe(400);
  });

  it("429 when rate limited", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    slidingWindow.mockReturnValue({ allowed: false });
    const res = await PATCH(patchReq({ dismissed: true }));
    expect(res.status).toBe(429);
  });

  it("checks the rate limit before reading the body", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    slidingWindow.mockReturnValue({ allowed: false });
    const res = await PATCH(patchReq("{not json"));
    expect(res.status).toBe(429);
    expect(patchOnboarding).not.toHaveBeenCalled();
  });

  it("an audit failure after the committed write still returns 200 and is logged", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    patchOnboarding.mockResolvedValue({ dismissedAt: "t" });
    logAudit.mockRejectedValue(new Error("audit down"));
    const res = await PATCH(patchReq({ dismissed: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ dismissedAt: "t" });
    expect(loggerError).toHaveBeenCalledTimes(1);
  });

  it("200 for dismissed, audits field names only", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    patchOnboarding.mockResolvedValue({ dismissedAt: "t" });
    const res = await PATCH(patchReq({ dismissed: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ dismissedAt: "t" });
    expect(patchOnboarding).toHaveBeenCalledWith(ORG, { dismissed: true }, { demo: false });
    expect(logAudit).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: SESSION.userId,
      action: "onboarding_updated",
      entity: "organization_settings",
      entityId: ORG,
      details: JSON.stringify({ keys: ["dismissed"] }),
    });
  });

  it("200 for showOnHome, audits the key name only", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await PATCH(patchReq({ showOnHome: true }));
    expect(res.status).toBe(200);
    expect(patchOnboarding).toHaveBeenCalledWith(ORG, { showOnHome: true }, { demo: false });
    expect(logAudit.mock.calls[0][0].details).toBe(JSON.stringify({ keys: ["showOnHome"] }));
  });

  it("audits flags.embedCopied", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await PATCH(patchReq({ flags: { embedCopied: true } }));
    expect(res.status).toBe(200);
    expect(logAudit.mock.calls[0][0].details).toBe(
      JSON.stringify({ keys: ["flags.embedCopied"] }),
    );
  });

  it("demo org: patched in memory, no audit", async () => {
    getAdminSession.mockResolvedValue({ ...SESSION, organizationId: DEMO_ORG_ID });
    const res = await PATCH(patchReq({ completedSeen: true }));
    expect(res.status).toBe(200);
    expect(patchOnboarding).toHaveBeenCalledWith(
      DEMO_ORG_ID,
      { completedSeen: true },
      { demo: true },
    );
    expect(logAudit).not.toHaveBeenCalled();
  });
});
