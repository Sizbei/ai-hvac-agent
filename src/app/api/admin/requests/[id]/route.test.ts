import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// after() throws outside a Next request scope; stub it, keep the rest real.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
// The route reads the viewer; derive it from the session mock (an org user).
vi.mock("@/lib/auth/viewer", async () => {
  const { getAdminSession } = await import("@/lib/auth/session");
  return {
    getViewerContext: async () => {
      const session = await getAdminSession();
      return session ? { session, showHidden: false } : null;
    },
  };
});
vi.mock("@/lib/admin/queries", () => ({
  getRequestById: vi.fn(async () => ({ id: "detail" })),
  updateRequestStatus: vi.fn(),
  scheduleRequest: vi.fn(),
  addRequestNote: vi.fn(),
}));
vi.mock("@/lib/tech/status-writes", async (importOriginal) => ({
  isDeadlock: (await importOriginal<typeof import("@/lib/tech/status-writes")>()).isDeadlock,
  readRequestState: vi.fn(),
  holdVisit: vi.fn(),
  completeRequestFromAdmin: vi.fn(),
}));
vi.mock("@/lib/tech/ownership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tech/ownership")>()),
  findActiveVisit: vi.fn(),
}));
vi.mock("@/lib/admin/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/admin/current-visit", () => ({ readVisitEnded: vi.fn(async () => false) }));
vi.mock("@/lib/integrations/google-calendar/sync", () => ({ syncRequestToCalendar: vi.fn(), deleteRequestFromCalendar: vi.fn() }));
vi.mock("@/lib/integrations/housecall-pro/job-sync", () => ({ pushJobToHcp: vi.fn(), cancelHcpJob: vi.fn() }));
vi.mock("@/lib/integrations/fieldpulse/job-sync", () => ({ pushJobToFieldpulse: vi.fn(), cancelFieldpulseJob: vi.fn() }));
vi.mock("@/lib/integrations/housecall-pro/note-sync", () => ({ syncJobNoteToHcp: vi.fn() }));
vi.mock("@/lib/integrations/fieldpulse/note-sync", () => ({ syncNoteToFieldpulse: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60000 }, adminRead: { maxRequests: 60, windowMs: 60000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("@/lib/admin/visit-one-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin/visit-one-guard")>()),
  isFieldpulseMapped: vi.fn(async () => false),
}));

import { PATCH } from "./route";
import { getAdminSession } from "@/lib/auth/session";
import { getRequestById, scheduleRequest, updateRequestStatus } from "@/lib/admin/queries";
import { completeRequestFromAdmin, holdVisit, readRequestState } from "@/lib/tech/status-writes";
import { findActiveVisit } from "@/lib/tech/ownership";
import { logAudit } from "@/lib/admin/audit";
import { readVisitEnded } from "@/lib/admin/current-visit";

const RID = "11111111-1111-4111-8111-111111111111";
const A1 = "22222222-2222-4222-8222-222222222222";
const patch = (body: unknown) =>
  PATCH(new Request("http://t/api", { method: "PATCH", body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: RID }) } as never);
const mocked = (f: unknown) => f as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mocked(getAdminSession).mockResolvedValue({ userId: "admin-1", organizationId: "org" });
});

describe("PATCH /api/admin/requests/[id] — status routing", () => {
  it("native on_hold goes to holdVisit on the active visit, with the reason and the admin as actor", async () => {
    mocked(readRequestState).mockResolvedValue({ status: "in_progress", native: true });
    mocked(findActiveVisit).mockResolvedValue({ appointmentId: A1, leadTechnicianId: "t" });
    mocked(holdVisit).mockResolvedValue({ ok: true });
    const res = await patch({ status: "on_hold", holdReason: "awaiting_parts" });
    expect(res.status).toBe(200);
    expect(holdVisit).toHaveBeenCalledWith({
      organizationId: "org", actorUserId: "admin-1", requestId: RID, appointmentId: A1,
      holdReason: "awaiting_parts", followUpDate: null, requestStatus: "in_progress",
    });
    expect(updateRequestStatus).not.toHaveBeenCalled();
    expect(mocked(logAudit).mock.calls[0]![0].details).toBe(JSON.stringify({ status: "on_hold" }));
  });

  it("synced on_hold keeps updateRequestStatus", async () => {
    mocked(readRequestState).mockResolvedValue({ status: "in_progress", native: false });
    mocked(updateRequestStatus).mockResolvedValue({ ok: true, status: "on_hold" });
    expect((await patch({ status: "on_hold" })).status).toBe(200);
    expect(updateRequestStatus).toHaveBeenCalled();
    expect(holdVisit).not.toHaveBeenCalled();
    // The read-back goes through the viewer: a hidden row reads back as 404.
    expect(getRequestById).toHaveBeenCalledWith("org", RID, expect.objectContaining({ showHidden: false }));
  });

  it("native completed goes to completeRequestFromAdmin", async () => {
    mocked(readRequestState).mockResolvedValue({ status: "in_progress", native: true });
    mocked(completeRequestFromAdmin).mockResolvedValue({ ok: true, changed: true });
    expect((await patch({ status: "completed" })).status).toBe(200);
    expect(completeRequestFromAdmin).toHaveBeenCalledWith({ organizationId: "org", actorUserId: "admin-1", requestId: RID });
    expect(updateRequestStatus).not.toHaveBeenCalled();
  });

  it("409 CLOSE_OUT_BLOCKED carries the blockers in the body only", async () => {
    mocked(readRequestState).mockResolvedValue({ status: "in_progress", native: true });
    const blockers = [{ kind: "technician_open", technicianName: "Ann", technicianId: "t", appointmentNumber: 1 }];
    mocked(completeRequestFromAdmin).mockResolvedValue({ ok: false, reason: "blocked", blockers });
    const res = await patch({ status: "completed" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toEqual({ message: "A technician is still working this job.", code: "CLOSE_OUT_BLOCKED", details: { blockers } });
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("409 INVALID_TRANSITION carries the current status", async () => {
    mocked(readRequestState).mockResolvedValue({ status: "assigned", native: true });
    mocked(completeRequestFromAdmin).mockResolvedValue({ ok: false, reason: "invalid_transition", currentStatus: "assigned" });
    const res = await patch({ status: "completed" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({
      code: "INVALID_TRANSITION",
      message: "This request is assigned now, so that change can’t be made. Reload to see the latest.",
      details: { currentStatus: "assigned" },
    });
  });

  it("409 STALE when the hold lost a race", async () => {
    mocked(readRequestState).mockResolvedValue({ status: "in_progress", native: true });
    mocked(findActiveVisit).mockResolvedValue(null);
    mocked(holdVisit).mockResolvedValue({ ok: false, reason: "stale" });
    const res = await patch({ status: "on_hold" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("STALE");
    expect(mocked(holdVisit).mock.calls[0]![0].appointmentId).toBeNull();
  });

  it("409 STALE on a deadlock", async () => {
    mocked(readRequestState).mockResolvedValue({ status: "in_progress", native: true });
    mocked(completeRequestFromAdmin).mockRejectedValue(Object.assign(new Error("q"), { cause: { code: "40P01" } }));
    const res = await patch({ status: "completed" });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("STALE");
  });
});

describe("PATCH /api/admin/requests/[id] — resuming a hold (round-2 P0)", () => {
  it.each(["scheduled", "en_route", "arrived", "in_progress"])(
    "native held request whose visit ended: %s → 409 VISIT_ENDED, nothing written",
    async (target) => {
      mocked(readRequestState).mockResolvedValue({ status: "on_hold", native: true });
      mocked(readVisitEnded).mockResolvedValue(true);
      const res = await patch({ status: target });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toEqual({
        code: "VISIT_ENDED",
        message: "This visit ended when the request was put on hold. Schedule the next visit instead.",
      });
      expect(readVisitEnded).toHaveBeenCalledWith("org", RID);
      expect(updateRequestStatus).not.toHaveBeenCalled();
      expect(logAudit).not.toHaveBeenCalled();
    },
  );

  it("a held request with a live visit still resumes by status", async () => {
    mocked(readRequestState).mockResolvedValue({ status: "on_hold", native: true });
    mocked(readVisitEnded).mockResolvedValue(false);
    mocked(updateRequestStatus).mockResolvedValue({ ok: true, status: "scheduled" });
    expect((await patch({ status: "scheduled" })).status).toBe(200);
    expect(updateRequestStatus).toHaveBeenCalled();
  });

  it("synced held requests and non-held requests never consult the visit", async () => {
    mocked(readRequestState).mockResolvedValue({ status: "on_hold", native: false });
    mocked(updateRequestStatus).mockResolvedValue({ ok: true, status: "scheduled" });
    expect((await patch({ status: "scheduled" })).status).toBe(200);
    mocked(readRequestState).mockResolvedValue({ status: "assigned", native: true });
    mocked(updateRequestStatus).mockResolvedValue({ ok: true, status: "en_route" });
    expect((await patch({ status: "en_route" })).status).toBe(200);
    expect(readVisitEnded).not.toHaveBeenCalled();
  });

  it("cancelling or completing a held request is still allowed", async () => {
    mocked(readRequestState).mockResolvedValue({ status: "on_hold", native: true });
    mocked(updateRequestStatus).mockResolvedValue({ ok: true, status: "cancelled" });
    expect((await patch({ status: "cancelled" })).status).toBe(200);
    expect(readVisitEnded).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/admin/requests/[id] — schedule branch", () => {
  it.each([
    ["has_progress", "HAS_PROGRESS", "A technician has started this visit. To move it anyway, use Move… on the calendar."],
    ["visit_ended", "VISIT_ENDED", "This visit has ended. Add a new visit instead."],
  ])("%s → 409 %s", async (reason, code, message) => {
    mocked(scheduleRequest).mockResolvedValue({ ok: false, reason });
    const res = await patch({ scheduledDate: "2026-11-02T00:00:00.000Z", arrivalWindow: "morning" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({ code, message });
  });
});
