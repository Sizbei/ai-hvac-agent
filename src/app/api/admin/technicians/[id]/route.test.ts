import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const updateTechnician = vi.fn();
vi.mock("@/lib/admin/queries", () => ({
  updateTechnician: (...a: unknown[]) => updateTechnician(...a),
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

import { PATCH } from "./route";

const SESSION = {
  userId: "11111111-1111-1111-1111-111111111111",
  organizationId: "00000000-0000-0000-0000-000000000009",
  email: "chick@spears.com",
  name: "Chick",
  role: "super_admin" as const,
};
const TECH = "22222222-2222-2222-2222-222222222222";

function patch(body: unknown) {
  return PATCH(
    new Request(`https://app.example.com/api/admin/technicians/${TECH}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: TECH }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
});

describe("PATCH /api/admin/technicians/[id]", () => {
  it("passes the whole session as the actor and returns the technician", async () => {
    updateTechnician.mockResolvedValue({
      ok: true,
      technician: {
        id: TECH,
        name: "Renamed",
        email: "t@x.com",
        isActive: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const res = await patch({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.name).toBe("Renamed");
    expect(updateTechnician).toHaveBeenCalledWith(
      SESSION.organizationId,
      TECH,
      { name: "Renamed" },
      SESSION,
    );
  });

  it("PATCH 403 PLATFORM_PROTECTED when changing an email to a platform-admin email", async () => {
    updateTechnician.mockResolvedValue({ ok: false, reason: "platform_protected" });
    const res = await patch({ email: "r@x.com" });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("PLATFORM_PROTECTED");
    expect(json.error.message).toBe(
      "This account is managed by the platform owner and can’t be changed here.",
    );
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("PATCH 404 when the technician does not exist", async () => {
    updateTechnician.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await patch({ name: "Renamed" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(logAudit).not.toHaveBeenCalled();
  });
});
