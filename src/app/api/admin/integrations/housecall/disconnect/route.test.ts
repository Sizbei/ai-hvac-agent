import { describe, it, expect, vi, beforeEach } from "vitest";

// The route imports isSuperAdmin from authz, whose chain pulls `server-only`.
vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const disconnectHousecallConnection = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/integrations/housecall-pro/connection-queries", () => ({
  disconnectHousecallConnection: (...a: unknown[]) => disconnectHousecallConnection(...a),
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

import { POST } from "./route";

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
});

describe("POST /api/admin/integrations/housecall/disconnect", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await POST()).status).toBe(401);
  });

  it("Gsettings-2: 403 for a non-super_admin admin", async () => {
    getAdminSession.mockResolvedValue(ADMIN);
    const res = await POST();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(disconnectHousecallConnection).not.toHaveBeenCalled();
  });

  it("disconnects + audits for a super_admin", async () => {
    getAdminSession.mockResolvedValue(SUPER);
    const res = await POST();
    expect(res.status).toBe(200);
    expect(disconnectHousecallConnection).toHaveBeenCalledWith("org-1");
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "housecall_pro_disconnected" }),
    );
  });
});
