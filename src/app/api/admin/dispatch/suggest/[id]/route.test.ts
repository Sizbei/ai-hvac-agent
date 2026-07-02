import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const suggestTechnicians = vi.fn();
vi.mock("@/lib/admin/scheduling-queries", () => ({
  suggestTechnicians: (...a: unknown[]) => suggestTechnicians(...a),
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "./route";

const REQ_ID = "33333333-3333-3333-3333-333333333333";
const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

function req() {
  return new NextRequest(
    `https://app.example.com/api/admin/dispatch/suggest/${REQ_ID}`,
  );
}
function ctx(id = REQ_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/dispatch/suggest/[id]", () => {
  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await GET(req(), ctx());
    expect(res.status).toBe(401);
    expect(suggestTechnicians).not.toHaveBeenCalled();
  });

  it("400 on a malformed request id", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const res = await GET(req(), ctx("not-a-uuid"));
    expect(res.status).toBe(400);
    expect(suggestTechnicians).not.toHaveBeenCalled();
  });

  it("returns suggestions, scoping the org to the SESSION (not the request)", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const ranked = [
      { technicianId: "t1", score: 0.9, reasons: ["5 prior no_cool jobs", "80% close rate"], skillMatched: true },
    ];
    suggestTechnicians.mockResolvedValue(ranked);

    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.suggestions).toEqual(ranked);
    // org comes from the session, request id from the path, limit 3.
    expect(suggestTechnicians).toHaveBeenCalledWith("org-1", REQ_ID, 3);
  });

  it("500 when the query throws (never leaks the error)", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    suggestTechnicians.mockRejectedValue(new Error("db down"));
    const res = await GET(req(), ctx());
    expect(res.status).toBe(500);
  });
});
