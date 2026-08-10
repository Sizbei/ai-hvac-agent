import { describe, it, expect, vi, beforeEach } from "vitest";

// The route imports isSuperAdmin from authz, whose chain pulls `server-only`.
vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const getGoogleOAuthConfig = vi.fn();
const buildConsentUrl = vi.fn((..._a: unknown[]) => "https://accounts.google.com/consent");
vi.mock("@/lib/integrations/google-calendar/oauth", () => ({
  getGoogleOAuthConfig: (...a: unknown[]) => getGoogleOAuthConfig(...a),
  buildConsentUrl: (...a: unknown[]) => buildConsentUrl(...a),
}));

vi.mock("@/lib/integrations/google-calendar/oauth-state", () => ({
  GOOGLE_OAUTH_STATE_COOKIE: "gcal_oauth_state",
  GOOGLE_OAUTH_STATE_MAX_AGE: 600,
  createOAuthState: () => "state-123",
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { GET } from "./route";

const SUPER = {
  userId: "u-1",
  organizationId: "org-1",
  email: "super@x.com",
  name: "Super",
  role: "super_admin" as const,
};
const ADMIN = { ...SUPER, role: "admin" as const };

beforeEach(() => {
  vi.clearAllMocks();
  getGoogleOAuthConfig.mockReturnValue({
    clientId: "id",
    clientSecret: "secret",
    redirectUri: "https://app.example.com/callback",
  });
});

describe("GET /api/admin/integrations/google/connect", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("Gsettings-2: 403 for a non-super_admin admin", async () => {
    getAdminSession.mockResolvedValue(ADMIN);
    const res = await GET();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(buildConsentUrl).not.toHaveBeenCalled();
  });

  it("redirects to the consent screen for a super_admin", async () => {
    getAdminSession.mockResolvedValue(SUPER);
    const res = await GET();
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(buildConsentUrl).toHaveBeenCalled();
  });
});
