import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const createTechnician = vi.fn();
vi.mock("@/lib/admin/queries", () => ({
  getTechnicians: vi.fn(),
  createTechnician: (...a: unknown[]) => createTechnician(...a),
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: {
    adminRead: { maxRequests: 60, windowMs: 60_000 },
    adminMutation: { maxRequests: 30, windowMs: 60_000 },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { POST } from "./route";

const SESSION = {
  userId: "11111111-1111-1111-1111-111111111111",
  organizationId: "00000000-0000-0000-0000-000000000009",
  email: "chick@spears.com",
  name: "Chick",
  role: "super_admin" as const,
};

function post(body: unknown) {
  return POST(
    new Request("https://app.example.com/api/admin/technicians", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const BODY = { name: "New Tech", email: "new@x.com", password: "password123" };

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
});

describe("POST /api/admin/technicians", () => {
  it("passes the whole session as the actor and returns 201", async () => {
    createTechnician.mockResolvedValue({
      ok: true,
      technician: {
        id: "t1",
        name: "New Tech",
        email: "new@x.com",
        isActive: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const res = await post(BODY);
    expect(res.status).toBe(201);
    expect((await res.json()).data.id).toBe("t1");
    expect(createTechnician).toHaveBeenCalledWith(
      SESSION.organizationId,
      BODY,
      SESSION,
    );
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create_technician", entityId: "t1" }),
    );
  });

  it("POST 403 FORBIDDEN when the email is a platform-admin email", async () => {
    createTechnician.mockResolvedValue({ ok: false, reason: "forbidden" });
    const res = await post({ ...BODY, email: "r@x.com" });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error.code).toBe("FORBIDDEN");
    expect(logAudit).not.toHaveBeenCalled();
  });
});
