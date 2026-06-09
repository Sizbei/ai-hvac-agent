import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";

// WIRING TEST: a successful reschedule must schedule a Housecall Pro job UPDATE
// in the background via after(). We mock the route's collaborators so the test
// asserts only the wiring — that pushJobToHcp is scheduled with (orgId, id) —
// without touching the DB, HCP, or the real session/rate-limit machinery.

const after = vi.fn((cb: () => unknown) => {
  // Run the scheduled callback synchronously so we can observe its target.
  void cb();
});
// Keep the real NextResponse/NextRequest (api-response.ts uses NextResponse);
// only swap after() for our synchronous spy.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (cb: () => unknown) => after(cb) };
});

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const placeAndAssignRequest = vi.fn();
vi.mock("@/lib/admin/scheduling-queries", () => ({
  placeAndAssignRequest: (...args: unknown[]) =>
    placeAndAssignRequest(...args),
}));

const syncRequestToCalendar = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/integrations/google-calendar/sync", () => ({
  syncRequestToCalendar: (...args: unknown[]) => syncRequestToCalendar(...args),
}));

const pushJobToHcp = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/integrations/housecall-pro/job-sync", () => ({
  pushJobToHcp: (...args: unknown[]) => pushJobToHcp(...args),
}));

vi.mock("@/lib/admin/calendar-time", () => ({
  arrivalWindowUtcForBusinessDate: () => ({
    start: new Date("2026-07-01T12:00:00.000Z"),
    end: new Date("2026-07-01T16:00:00.000Z"),
  }),
  isRealIsoDate: () => true,
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({ logAudit: (...a: unknown[]) => logAudit(...a) }));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "./route";

const VALID_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: unknown) {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
  after.mockClear();
  getAdminSession.mockReset();
  placeAndAssignRequest.mockReset();
  pushJobToHcp.mockClear();
  syncRequestToCalendar.mockClear();
});

describe("POST reschedule — HCP wiring", () => {
  it("schedules pushJobToHcp(orgId, id) after a successful reschedule", async () => {
    getAdminSession.mockResolvedValue({
      organizationId: "org-1",
      userId: "user-1",
    });
    placeAndAssignRequest.mockResolvedValue({
      ok: true,
      status: "scheduled",
      scheduledDate: "2026-07-01T12:00:00.000Z",
      arrivalWindowStart: "2026-07-01T12:00:00.000Z",
      arrivalWindowEnd: "2026-07-01T16:00:00.000Z",
      assignedTo: null,
      conflicts: [],
    });

    const res = await POST(
      makeRequest({ date: "2026-07-01", arrivalWindow: "morning" }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(res.status).toBe(200);
    expect(pushJobToHcp).toHaveBeenCalledWith("org-1", VALID_ID);
  });

  it("does NOT schedule pushJobToHcp when the reschedule is rejected", async () => {
    getAdminSession.mockResolvedValue({
      organizationId: "org-1",
      userId: "user-1",
    });
    placeAndAssignRequest.mockResolvedValue({
      ok: false,
      reason: "request_not_found",
    });

    await POST(
      makeRequest({ date: "2026-07-01", arrivalWindow: "morning" }),
      { params: Promise.resolve({ id: VALID_ID }) },
    );

    expect(pushJobToHcp).not.toHaveBeenCalled();
  });
});
