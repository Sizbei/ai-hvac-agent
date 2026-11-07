import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// after() throws outside a Next request scope; stub it, keep the rest real.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => void fn };
});
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
vi.mock("@/lib/admin/scheduling-queries", () => ({ unscheduleRequest: vi.fn() }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/integrations/google-calendar/sync", () => ({
  syncRequestToCalendar: vi.fn(),
}));
vi.mock("@/lib/integrations/housecall-pro/job-sync", () => ({
  pushJobToHcp: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60000 } },
}));

import { POST } from "./route";
import { getAdminSession } from "@/lib/auth/session";
import { unscheduleRequest } from "@/lib/admin/scheduling-queries";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const GATE = { visitId: "22222222-2222-4222-8222-222222222222", expectedVersion: 3 };
const req = (body: unknown = GATE) =>
  new Request("http://t/api", { method: "POST", body: JSON.stringify(body) }) as never;
const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => vi.clearAllMocks());

describe("POST unschedule", () => {
  it("401 without a session", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue(null);
    const res = await POST(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(401);
  });

  it("400 on a malformed id", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue({
      userId: "u",
      organizationId: "o",
    });
    const res = await POST(req(), ctx("not-a-uuid") as never);
    expect(res.status).toBe(400);
  });

  it("200 when the mutation succeeds", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue({
      userId: "u",
      organizationId: "o",
    });
    (unscheduleRequest as unknown as Mock).mockResolvedValue({ ok: true });
    const res = await POST(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(200);
  });

  it("409 when the job is terminal", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue({
      userId: "u",
      organizationId: "o",
    });
    (unscheduleRequest as unknown as Mock).mockResolvedValue({
      ok: false,
      reason: "request_terminal",
      currentStatus: "completed",
    });
    const res = await POST(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(409);
  });

  it("409 HAS_PROGRESS / VISIT_ENDED when visit #1 refuses", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
    for (const [reason, code] of [["has_progress", "HAS_PROGRESS"], ["visit_ended", "VISIT_ENDED"]]) {
      (unscheduleRequest as unknown as Mock).mockResolvedValue({ ok: false, reason });
      const res = await POST(req(), ctx(VALID_ID) as never);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe(code);
    }
  });
});

describe("POST unschedule — M2", () => {
  beforeEach(() => {
    (getAdminSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
  });
  it("passes the card's visit and version (lowercased) to the writer", async () => {
    (unscheduleRequest as unknown as Mock).mockResolvedValue({ ok: true });
    await POST(req({ visitId: GATE.visitId.toUpperCase(), expectedVersion: 3 }), ctx(VALID_ID.toUpperCase()) as never);
    expect(unscheduleRequest).toHaveBeenCalledWith("o", VALID_ID, { visitId: GATE.visitId, expectedVersion: 3 });
  });
  it("a null visit with a null version is allowed; a half-null body is 400", async () => {
    (unscheduleRequest as unknown as Mock).mockResolvedValue({ ok: true });
    expect((await POST(req({ visitId: null, expectedVersion: null }), ctx(VALID_ID) as never)).status).toBe(200);
    expect((await POST(req({ visitId: null, expectedVersion: 1 }), ctx(VALID_ID) as never)).status).toBe(400);
    expect((await POST(req({}), ctx(VALID_ID) as never)).status).toBe(400);
  });
  it.each([
    ["managed_externally", "MANAGED_EXTERNALLY", "Change this request in FieldPulse."],
    ["stale", "STALE", "This request changed. The calendar has been refreshed."],
    ["work_logged", "WORK_LOGGED", "Work was logged on this visit, so it can’t go back to Unscheduled."],
    ["has_progress", "HAS_PROGRESS", "A technician has started this visit, so it can’t go back to Unscheduled."],
  ])("%s → 409 %s", async (reason, code, message) => {
    (unscheduleRequest as unknown as Mock).mockResolvedValue({ ok: false, reason });
    const res = await POST(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({ code, message });
  });
});
