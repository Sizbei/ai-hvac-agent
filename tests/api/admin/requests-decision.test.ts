import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockGetAdminSession, mockGetDecision } = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockGetDecision: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
}));
vi.mock("@/lib/admin/dispatch-decision-queries", () => ({
  getDispatchDecisionForRequest: (...a: unknown[]) => mockGetDecision(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { GET } from "@/app/api/admin/requests/[id]/decision/route";

const session = {
  userId: "u1",
  organizationId: "org-1",
  email: "a@b.c",
  name: "A",
  role: "admin" as const,
};
const VALID = "550e8400-e29b-41d4-a716-446655440000";

function req(): NextRequest {
  return new NextRequest(`http://localhost/api/admin/requests/${VALID}/decision`);
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/admin/requests/[id]/decision", () => {
  it("401 when unauthenticated", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await GET(req(), { params: Promise.resolve({ id: VALID }) });
    expect(res.status).toBe(401);
  });

  it("400 on a non-UUID id", async () => {
    mockGetAdminSession.mockResolvedValue(session);
    const res = await GET(req(), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when there is no decision row", async () => {
    mockGetAdminSession.mockResolvedValue(session);
    mockGetDecision.mockResolvedValue(null);
    const res = await GET(req(), { params: Promise.resolve({ id: VALID }) });
    expect(res.status).toBe(404);
  });

  it("200 with the decision view", async () => {
    mockGetAdminSession.mockResolvedValue(session);
    mockGetDecision.mockResolvedValue({
      outcome: "committed",
      isShadow: false,
      chosenTechnicianId: "t1",
      topScore: 0.8,
      confidenceGap: 0.1,
      createdAt: "2026-07-20T10:00:00.000Z",
      overriddenTechnicianId: null,
      overriddenByUserId: null,
      overriddenAt: null,
      candidates: [],
    });
    const res = await GET(req(), { params: Promise.resolve({ id: VALID }) });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.outcome).toBe("committed");
    expect(mockGetDecision).toHaveBeenCalledWith("org-1", VALID);
  });
});
