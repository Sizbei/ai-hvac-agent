import { describe, it, expect, vi, beforeEach } from "vitest";

// The route imports isSuperAdmin from authz, whose chain pulls `server-only`.
vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const getGoogleOAuthConfig = vi.fn((..._a: unknown[]) => ({
  clientId: "id",
  clientSecret: "secret",
  redirectUri: "https://app.example.com/callback",
}));
vi.mock("@/lib/integrations/google-calendar/oauth", () => ({
  getGoogleOAuthConfig: (...a: unknown[]) => getGoogleOAuthConfig(...a),
}));

const getGoogleConnectionStatus = vi.fn();
const disconnectGoogleConnection = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/integrations/google-calendar/connection-queries", () => ({
  getGoogleConnectionStatus: (...a: unknown[]) => getGoogleConnectionStatus(...a),
  disconnectGoogleConnection: (...a: unknown[]) => disconnectGoogleConnection(...a),
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

import { GET, DELETE } from "./route";

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
  getGoogleConnectionStatus.mockResolvedValue({ connected: true, calendarId: "primary" });
});

describe("GET /api/admin/integrations/google (status)", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("200 for any admin-tier session (status is a read, not gated to super_admin)", async () => {
    getAdminSession.mockResolvedValue(ADMIN);
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

describe("DELETE /api/admin/integrations/google (disconnect)", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await DELETE()).status).toBe(401);
    expect(disconnectGoogleConnection).not.toHaveBeenCalled();
  });

  it("Gsettings-2: 403 for a non-super_admin admin", async () => {
    getAdminSession.mockResolvedValue(ADMIN);
    const res = await DELETE();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(disconnectGoogleConnection).not.toHaveBeenCalled();
  });

  it("disconnects + audits for a super_admin", async () => {
    getAdminSession.mockResolvedValue(SUPER);
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(disconnectGoogleConnection).toHaveBeenCalledWith("org-1");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "google_calendar_disconnected" }),
    );
  });
});
