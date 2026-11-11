import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getAdminSession: () => getAdminSession() }));
const isPlatformAdmin = vi.fn();
vi.mock("@/lib/auth/authz", () => ({ isPlatformAdmin: (s: unknown) => isPlatformAdmin(s) }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 60, windowMs: 60_000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));
const select = vi.fn();
vi.mock("@/lib/db", () => ({ db: { select: () => select() } }));

import { GET } from "./route";

const SESSION = { userId: "u1", organizationId: "org-1", email: "a@x.example", name: "A", role: "super_admin" };

function chain(rows: unknown[]) {
  const c = { from: () => c, where: () => c, orderBy: () => c, limit: async () => rows };
  return c;
}

beforeEach(() => {
  getAdminSession.mockReset();
  isPlatformAdmin.mockReset();
  select.mockReset();
});

describe("GET /api/admin/integrations/fieldpulse/import-status", () => {
  it("is 401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("is 404 for an org admin who is not a platform user, and reads nothing", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    isPlatformAdmin.mockReturnValue(false);
    expect((await GET()).status).toBe(404);
    expect(select).not.toHaveBeenCalled();
  });

  it("returns the org's runs to a platform user", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    isPlatformAdmin.mockReturnValue(true);
    select.mockReturnValue(
      chain([{ id: "r1", startedAt: new Date("2026-11-10T00:00:00Z"), finishedAt: null }]),
    );
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).data.runs[0]).toMatchObject({ id: "r1", startedAt: "2026-11-10T00:00:00.000Z" });
  });
});
