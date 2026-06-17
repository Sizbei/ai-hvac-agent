import { describe, it, expect, vi, beforeEach } from "vitest";

// authz.ts imports "server-only", which throws in the vitest (non-RSC) runtime.
// Stub it to a no-op so the route module can be imported under test.
vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

// db chain mocks: select(...).from().where().limit() and
// insert(...).values().onConflictDoUpdate().
const limit = vi.fn(async () => [{ aiModelId: "glm-4.6" }]);
const onConflictDoUpdate = vi.fn(async () => undefined);
const dbSelect = vi.fn(() => ({
  from: () => ({ where: () => ({ limit }) }),
}));
const dbInsert = vi.fn(() => ({
  values: () => ({ onConflictDoUpdate }),
}));
vi.mock("@/lib/db", () => ({
  db: { select: () => dbSelect(), insert: () => dbInsert() },
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { NextRequest } from "next/server";
import { GET, PUT } from "./route";

const SUPER = {
  userId: "11111111-1111-1111-1111-111111111111",
  organizationId: "00000000-0000-0000-0000-000000000001",
  email: "super@x.com",
  name: "Super",
  role: "super_admin" as const,
};
const ADMIN = { ...SUPER, role: "admin" as const };

function putReq(body: unknown) {
  return new NextRequest("https://app.example.com/api/admin/ai/model", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getAdminSession.mockReset();
  logAudit.mockClear();
  onConflictDoUpdate.mockClear();
});

describe("GET /api/admin/ai/model", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("403 for a non-super_admin", async () => {
    getAdminSession.mockResolvedValue(ADMIN);
    expect((await GET()).status).toBe(403);
  });

  it("returns choices + selectedId for a super_admin (no secrets)", async () => {
    getAdminSession.mockResolvedValue(SUPER);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.selectedId).toBe("glm-4.6");
    for (const choice of json.data.choices) {
      expect(Object.keys(choice).sort()).toEqual(["id", "label"]);
    }
  });
});

describe("PUT /api/admin/ai/model", () => {
  it("403 for a non-super_admin", async () => {
    getAdminSession.mockResolvedValue(ADMIN);
    expect((await PUT(putReq({ modelId: "glm-4.6" }))).status).toBe(403);
  });

  it("400 for an unknown model id", async () => {
    getAdminSession.mockResolvedValue(SUPER);
    const res = await PUT(putReq({ modelId: "nope" }));
    expect(res.status).toBe(400);
  });

  it("persists + audits a valid selection", async () => {
    getAdminSession.mockResolvedValue(SUPER);
    const res = await PUT(putReq({ modelId: "glm-4.6" }));
    expect(res.status).toBe(200);
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ai_model_changed" }),
    );
  });
});
