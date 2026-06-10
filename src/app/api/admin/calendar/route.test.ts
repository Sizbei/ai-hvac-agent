import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const getSchedulingCalendar = vi.fn();
const getMonthCalendar = vi.fn();
vi.mock("@/lib/admin/queries", () => ({
  getSchedulingCalendar: (...a: unknown[]) => getSchedulingCalendar(...a),
  getMonthCalendar: (...a: unknown[]) => getMonthCalendar(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 60, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { NextRequest } from "next/server";
import { GET } from "./route";

const SESSION = {
  userId: "u1",
  organizationId: "org-1",
  email: "a@x.com",
  name: "A",
  role: "admin" as const,
};

function req(params: string) {
  return new NextRequest(`https://app.example.com/api/admin/calendar${params}`);
}

beforeEach(() => {
  getAdminSession.mockReset();
  getSchedulingCalendar.mockReset();
  getMonthCalendar.mockReset();
  getAdminSession.mockResolvedValue(SESSION);
  getSchedulingCalendar.mockResolvedValue({ days: [], lanes: [] });
  getMonthCalendar.mockResolvedValue({ month: "2026-06", days: [] });
});

describe("GET /api/admin/calendar", () => {
  it("401 without a session", async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await GET(req("?date=2026-06-10&view=day"));
    expect(res.status).toBe(401);
  });

  it("view=month routes to getMonthCalendar with a 35/42-day grid + month", async () => {
    const res = await GET(req("?date=2026-06-10&view=month"));
    expect(res.status).toBe(200);
    expect(getMonthCalendar).toHaveBeenCalledOnce();
    expect(getSchedulingCalendar).not.toHaveBeenCalled();

    const [org, startIso, endIso, gridDays, month] =
      getMonthCalendar.mock.calls[0];
    expect(org).toBe("org-1");
    expect(month).toBe("2026-06");
    expect(gridDays.length % 7).toBe(0);
    // June 2026 grid: leads Sun May 31, ends Sat Jul 4.
    expect(gridDays[0]).toBe("2026-05-31");
    expect(gridDays[gridDays.length - 1]).toBe("2026-07-04");
    // Half-open range covers the whole grid.
    expect(new Date(startIso).getTime()).toBeLessThan(
      new Date(endIso).getTime(),
    );
  });

  it("view=week routes to getSchedulingCalendar with 7 days", async () => {
    const res = await GET(req("?date=2026-06-10&view=week"));
    expect(res.status).toBe(200);
    expect(getSchedulingCalendar).toHaveBeenCalledOnce();
    expect(getMonthCalendar).not.toHaveBeenCalled();
    const days = getSchedulingCalendar.mock.calls[0][3];
    expect(days).toHaveLength(7);
  });

  it("view=day (default) routes to getSchedulingCalendar with 1 day", async () => {
    const res = await GET(req("?date=2026-06-10"));
    expect(res.status).toBe(200);
    expect(getSchedulingCalendar).toHaveBeenCalledOnce();
    const days = getSchedulingCalendar.mock.calls[0][3];
    expect(days).toEqual(["2026-06-10"]);
  });

  it("an unknown view falls back to day", async () => {
    await GET(req("?date=2026-06-10&view=bogus"));
    expect(getSchedulingCalendar).toHaveBeenCalledOnce();
    expect(getMonthCalendar).not.toHaveBeenCalled();
    expect(getSchedulingCalendar.mock.calls[0][3]).toEqual(["2026-06-10"]);
  });
});
