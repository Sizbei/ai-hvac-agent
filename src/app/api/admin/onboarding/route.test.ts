import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
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

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { NextRequest } from "next/server";
import { GET, PATCH } from "./route";
import { DEMO_ORG_ID } from "@/lib/tenancy/organization";

const ORG = "22222222-2222-2222-2222-222222222222";
const SESSION = {
  userId: "11111111-1111-1111-1111-111111111111",
  organizationId: ORG,
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};
const PAYLOAD = { steps: [], progress: { done: 0, total: 0 }, demo: false };

function patchReq(body: unknown) {
  return new NextRequest("https://app.example.com/api/admin/onboarding", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  getAdminSession.mockReset();
  getOnboarding.mockReset().mockResolvedValue(PAYLOAD);
  patchOnboarding.mockReset().mockResolvedValue({ flags: {} });
  logAudit.mockClear();
  slidingWindow.mockReset().mockReturnValue({ allowed: true });
});

describe("GET /api/admin/onboarding", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("429 when rate limited", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    slidingWindow.mockReturnValue({ allowed: false });
    const res = await GET();
    expect(res.status).toBe(429);
    expect(getOnboarding).not.toHaveBeenCalled();
  });

  it("returns the payload with no wrapper, demo false for a normal org", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual(PAYLOAD);
    expect(json.data.onboarding).toBeUndefined();
    expect(getOnboarding).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ demo: false, googleEnabled: false }),
    );
  });

  it("passes demo: true for the demo org", async () => {
    getAdminSession.mockResolvedValue({ ...SESSION, organizationId: DEMO_ORG_ID });
    await GET();
    expect(getOnboarding).toHaveBeenCalledWith(
      DEMO_ORG_ID,
      expect.objectContaining({ demo: true }),
    );
  });

  it("500 with generic copy when the query throws", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    getOnboarding.mockRejectedValue(new Error("secret db detail"));
    const res = await GET();
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
