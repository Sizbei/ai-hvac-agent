import { describe, it, expect, vi, beforeEach } from "vitest";

// The route imports isSuperAdmin from authz, whose chain pulls `server-only`.
vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const getAccountInfo = vi.fn();
vi.mock("@/lib/integrations/fieldpulse/client", () => ({
  RestFieldpulseClient: vi.fn().mockImplementation(function RestFieldpulseClient() {
    return { getAccountInfo: (...a: unknown[]) => getAccountInfo(...a) };
  }),
}));

vi.mock("@/lib/integrations/fieldpulse/config", () => ({
  FIELDPULSE_BASE_URL: "https://api.fieldpulse.com",
}));

const saveFieldpulseConnection = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/integrations/fieldpulse/connection-queries", () => ({
  saveFieldpulseConnection: (...a: unknown[]) => saveFieldpulseConnection(...a),
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

import { NextRequest } from "next/server";
import { POST } from "./route";

const SUPER = {
  userId: "u-1",
  organizationId: "org-1",
  email: "super@x.com",
  name: "Super",
  role: "super_admin" as const,
};
const ADMIN = { ...SUPER, role: "admin" as const };

function postReq(body: unknown) {
  return new NextRequest("https://app.example.com/api/admin/integrations/fieldpulse/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAccountInfo.mockResolvedValue({ accountId: "acct-1" });
});

describe("POST /api/admin/integrations/fieldpulse/connect", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await POST(postReq({ apiKey: "key" }))).status).toBe(401);
  });

  it("Gsettings-2: 403 for a non-super_admin admin", async () => {
    getAdminSession.mockResolvedValue(ADMIN);
    const res = await POST(postReq({ apiKey: "key" }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error?.code).toBe("FORBIDDEN");
    expect(saveFieldpulseConnection).not.toHaveBeenCalled();
  });

  it("connects + audits for a super_admin", async () => {
    getAdminSession.mockResolvedValue(SUPER);
    const res = await POST(postReq({ apiKey: "key" }));
    expect(res.status).toBe(200);
    expect(saveFieldpulseConnection).toHaveBeenCalledOnce();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "fieldpulse_connected" }),
    );
  });
});
