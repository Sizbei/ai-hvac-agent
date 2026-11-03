import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({ getAdminSession: () => getAdminSession() }));

const listTimesheetEntries = vi.fn();
vi.mock("@/lib/admin/timesheet-admin-queries", () => ({
  listTimesheetEntries: (...a: unknown[]) => listTimesheetEntries(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 60, windowMs: 60_000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "./route";

const TECH = "11111111-1111-4111-8111-111111111111";
const SESSION = { userId: "u-1", organizationId: "org-1", role: "admin" };

function req(qs: string) {
  return new NextRequest(`https://app.example.com/api/admin/timesheets?${qs}`);
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/admin/timesheets", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await GET(req(`technicianId=${TECH}&from=2026-11-01&to=2026-11-02`))).status).toBe(401);
  });

  it.each([
    ["technicianId=nope&from=2026-11-01&to=2026-11-02"],
    [`technicianId=${TECH}&from=2026-11-05&to=2026-11-02`],
    [`technicianId=${TECH}&from=2026-02-31&to=2026-03-02`],
    [`technicianId=${TECH}&from=2026-01-01&to=2026-06-01`],
    [`technicianId=${TECH}&from=2026-11-01`],
  ])("400 for bad params: %s", async (qs) => {
    getAdminSession.mockResolvedValue(SESSION);
    expect((await GET(req(qs))).status).toBe(400);
    expect(listTimesheetEntries).not.toHaveBeenCalled();
  });

  it("200 with entries scoped to the session org", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    listTimesheetEntries.mockResolvedValue([{ id: "e1" }]);
    const res = await GET(req(`technicianId=${TECH}&from=2026-11-01&to=2026-11-02`));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ entries: [{ id: "e1" }] });
    expect(listTimesheetEntries).toHaveBeenCalledWith("org-1", TECH, "2026-11-01", "2026-11-02");
  });
});
