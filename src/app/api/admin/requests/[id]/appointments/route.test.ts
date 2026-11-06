import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
vi.mock("@/lib/admin/appointment-queries", () => ({ listAppointments: vi.fn(), addAppointment: vi.fn() }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60000 }, adminRead: { maxRequests: 60, windowMs: 60000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { POST } from "./route";
import { getAdminSession } from "@/lib/auth/session";
import { addAppointment } from "@/lib/admin/appointment-queries";

const RID = "11111111-1111-4111-8111-111111111111";
const T1 = "33333333-3333-4333-8333-333333333333";
const mocked = (f: unknown) => f as Mock;
const post = (body: unknown) =>
  POST(
    new Request("http://t/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never,
    { params: Promise.resolve({ id: RID }) } as never,
  );
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  mocked(getAdminSession).mockResolvedValue({ userId: "admin-1", organizationId: "org" });
});

describe("POST /api/admin/requests/[id]/appointments — past windows", () => {
  it("refuses a window that has already ended (400 WINDOW_ENDED) without writing", async () => {
    const res = await post({ arrivalWindowStart: hoursFromNow(-8), arrivalWindowEnd: hoursFromNow(-4), technicianIds: [T1] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toEqual({
      code: "WINDOW_ENDED",
      message: "That arrival window has already ended. Pick a later one.",
    });
    expect(addAppointment).not.toHaveBeenCalled();
  });

  it("accepts a window that is under way", async () => {
    mocked(addAppointment).mockResolvedValue({ id: "v2", appointmentNumber: 2, assignments: [{ technicianId: T1 }] });
    const res = await post({ arrivalWindowStart: hoursFromNow(-1), arrivalWindowEnd: hoursFromNow(3), technicianIds: [T1] });
    expect(res.status).toBe(201);
    expect(addAppointment).toHaveBeenCalledWith("org", RID, expect.objectContaining({ technicianIds: [T1] }), "admin-1");
  });
});
