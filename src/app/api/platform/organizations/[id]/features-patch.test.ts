import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const isPlatformAdmin = vi.fn();
vi.mock("@/lib/auth/authz", () => ({
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
}));

vi.mock("@/lib/admin/erasure-queries", () => ({ purgeOrganization: vi.fn() }));

const updateOrgFeatures = vi.fn();
vi.mock("@/lib/admin/platform-features", () => ({
  updateOrgFeatures: (...a: unknown[]) => updateOrgFeatures(...a),
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

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { PATCH } from "./route";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const SESSION = {
  userId: "u-1",
  organizationId: "00000000-0000-0000-0000-000000000001",
  email: "platform@x.com",
  name: "Platform Admin",
  role: "super_admin" as const,
};
const FEATURES = { map: true, reviewRequests: true, payLinks: true, showHistory: false };

function req(body: unknown) {
  return new NextRequest(`https://app.example.com/api/platform/organizations/${ORG_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: "https://app.example.com" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ctx = (id = ORG_ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
  isPlatformAdmin.mockReturnValue(true);
  isSameOriginRequest.mockReturnValue(true);
  slidingWindow.mockReturnValue({ allowed: true });
});

describe("PATCH /api/platform/organizations/[id] (features)", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await PATCH(req({ features: { map: true } }), ctx())).status).toBe(401);
  });

  it("403 for a super_admin who is not a platform admin", async () => {
    isPlatformAdmin.mockReturnValue(false);
    const res = await PATCH(req({ features: { map: true } }), ctx());
    expect(res.status).toBe(403);
    expect(updateOrgFeatures).not.toHaveBeenCalled();
  });

  it("403 when Origin is cross-site", async () => {
    isSameOriginRequest.mockReturnValue(false);
    const res = await PATCH(req({ features: { map: true } }), ctx());
    expect(res.status).toBe(403);
    expect(updateOrgFeatures).not.toHaveBeenCalled();
  });

  it("checks platform authority before origin and rate limit", async () => {
    isPlatformAdmin.mockReturnValue(false);
    await PATCH(req({ features: { map: true } }), ctx());
    expect(isSameOriginRequest).not.toHaveBeenCalled();
    expect(slidingWindow).not.toHaveBeenCalled();
  });

  it("429 after the mutation rate limit, keyed per platform user", async () => {
    slidingWindow.mockReturnValue({ allowed: false });
    const res = await PATCH(req({ features: { map: true } }), ctx());
    expect(res.status).toBe(429);
    expect(slidingWindow).toHaveBeenCalledWith("platform:org-features:u-1", 30, 60_000);
  });

  it("400 INVALID_ID for a non-UUID id", async () => {
    const res = await PATCH(req({ features: { map: true } }), ctx("nope"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
  });

  it.each([
    ["empty features", { features: {} }],
    ["unknown key", { features: { bogus: true } }],
    ["non-boolean value", { features: { map: "yes" } }],
    ["missing features", {}],
  ])("400 VALIDATION_ERROR for %s", async (_n, body) => {
    const res = await PATCH(req(body), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect(updateOrgFeatures).not.toHaveBeenCalled();
  });

  it("400 VALIDATION_ERROR for a malformed JSON body", async () => {
    const res = await PATCH(req("{not json"), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("404 when the org does not exist", async () => {
    updateOrgFeatures.mockResolvedValue(null);
    expect((await PATCH(req({ features: { map: true } }), ctx())).status).toBe(404);
  });

  it("200 returns merged features and passes the actor without extras", async () => {
    updateOrgFeatures.mockResolvedValue(FEATURES);
    const res = await PATCH(req({ features: { map: true } }), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ features: FEATURES });
    expect(updateOrgFeatures).toHaveBeenCalledWith(
      ORG_ID,
      { map: true },
      { userId: "u-1", email: "platform@x.com" },
    );
  });

  it("500 without leaking the error message", async () => {
    updateOrgFeatures.mockRejectedValue(new Error("secret db detail"));
    const res = await PATCH(req({ features: { map: true } }), ctx());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
