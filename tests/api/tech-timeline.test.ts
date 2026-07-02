import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Route-guard tests for the tech job-timeline endpoint. Exercises the auth gate,
 * the assignee-guard → 404 mapping, and the org/tech-scoped query call. The
 * timeline query itself is unit-tested in field-queries.test.ts.
 */
const { mockGetAdminSession, mockGetJobTimelineForTech } = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockGetJobTimelineForTech: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
}));
vi.mock("@/lib/tech/field-queries", () => ({
  getJobTimelineForTech: (...a: unknown[]) => mockGetJobTimelineForTech(...a),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { GET } from "@/app/api/tech/jobs/[id]/timeline/route";
import { NextRequest } from "next/server";

const ORG = "00000000-0000-0000-0000-000000000001";
const TECH = "00000000-0000-0000-0000-0000000000aa";
const JOB = "job-1";

const params = Promise.resolve({ id: JOB });
const req = () => new NextRequest("http://test/api/tech/jobs/job-1/timeline");

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAdminSession.mockResolvedValue({
    userId: TECH,
    organizationId: ORG,
    email: "t@b.co",
    name: "T",
    role: "technician",
  });
});

describe("GET /api/tech/jobs/[id]/timeline", () => {
  it("401s without a session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await GET(req(), { params });
    expect(res.status).toBe(401);
    expect(mockGetJobTimelineForTech).not.toHaveBeenCalled();
  });

  it("404s when the job is not assigned to the tech (not_owned)", async () => {
    mockGetJobTimelineForTech.mockResolvedValue({ ok: false, reason: "not_owned" });
    const res = await GET(req(), { params });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("returns the timeline for an owned job, scoped by org + tech", async () => {
    const timeline = [
      { fromStatus: null, toStatus: "pending", actorType: "ai", at: "2026-06-24T10:00:00.000Z" },
    ];
    mockGetJobTimelineForTech.mockResolvedValue({ ok: true, timeline });
    const res = await GET(req(), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.timeline).toEqual(timeline);
    // org + tech from the SESSION, job id from the route param.
    expect(mockGetJobTimelineForTech).toHaveBeenCalledWith(ORG, TECH, JOB);
  });
});
