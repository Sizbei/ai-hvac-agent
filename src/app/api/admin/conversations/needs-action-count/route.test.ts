import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));
// The route reads the viewer; derive it from the session mock (an org user).
vi.mock("@/lib/auth/viewer", () => ({
  getViewerContext: async () => {
    const session = await getAdminSession();
    return session ? { session, showHidden: false } : null;
  },
}));

const buildNeedsActionCountQuery = vi.fn();
vi.mock("@/lib/admin/conversation-queries", () => ({
  buildNeedsActionCountQuery: (...a: unknown[]) => buildNeedsActionCountQuery(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 60, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { GET } from "./route";

describe("GET /api/admin/conversations/needs-action-count", () => {
  beforeEach(() => {
    getAdminSession.mockReset();
    buildNeedsActionCountQuery.mockReset();
  });

  it("401s without a session and never queries", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(buildNeedsActionCountQuery).not.toHaveBeenCalled();
  });

  it("counts within the session's org, coercing a string count", async () => {
    getAdminSession.mockResolvedValue({ userId: "u-1", organizationId: "org-1", role: "admin" });
    buildNeedsActionCountQuery.mockResolvedValue([{ value: "7" }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(buildNeedsActionCountQuery).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({ showHidden: false }),
    );
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(7);
  });

  it("returns human-safe 500 copy when the query fails", async () => {
    getAdminSession.mockResolvedValue({ userId: "u-1", organizationId: "org-1", role: "admin" });
    buildNeedsActionCountQuery.mockRejectedValue(new Error("boom select * from x"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("boom");
  });
});
