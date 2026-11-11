import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// after() throws outside a Next request scope; record it instead.
const { after } = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/ownership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tech/ownership")>()),
  findReadableJob: vi.fn(),
  findTechAssignments: vi.fn(),
  findAllAssignments: vi.fn(),
}));
vi.mock("@/lib/tech/status-writes", async (importOriginal) => ({
  isDeadlock: (await importOriginal<typeof import("@/lib/tech/status-writes")>()).isDeadlock,
  applyTechAction: vi.fn(),
  holdVisit: vi.fn(),
  closeOutRequest: vi.fn(),
  closeOutBlockers: vi.fn(async () => []),
}));
vi.mock("@/lib/reviews/review-queries", () => ({ createReviewRequest: vi.fn(async () => undefined) }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { POST } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { findAllAssignments, findReadableJob, findTechAssignments, type TechAssignmentRow } from "@/lib/tech/ownership";
import { applyTechAction, closeOutRequest, holdVisit } from "@/lib/tech/status-writes";

const RID = "11111111-1111-4111-8111-111111111111";
const A1 = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333333";
const T2 = "44444444-4444-4444-8444-444444444444";

const row = (over: Partial<TechAssignmentRow> = {}): TechAssignmentRow => ({
  assignmentId: "row-1", appointmentId: A1, appointmentNumber: 1, isLead: true, status: "in_progress",
  cancelledAt: null, enRouteAt: new Date(), arrivedAt: new Date(), startedAt: new Date(), completedAt: null,
  technicianId: T1, ...over,
});
const helper = row({ assignmentId: "row-2", isLead: false, technicianId: T2 });

const ctx = { params: Promise.resolve({ id: RID }) };
// Every body carries the caller's visit unless the test supplies its own.
const post = (body: Record<string, unknown>) =>
  POST(new Request("http://t/api", { method: "POST", body: JSON.stringify({ appointmentId: A1, ...body }) }) as never, ctx as never);
const code = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;

function as(me: string, mine: readonly TechAssignmentRow[], all: readonly TechAssignmentRow[], status = "in_progress", native = true) {
  (getTechSession as unknown as Mock).mockResolvedValue({ userId: me, organizationId: "org" });
  (findReadableJob as unknown as Mock).mockResolvedValue({ id: RID, customerId: "c", native, status });
  (findTechAssignments as unknown as Mock).mockResolvedValue(mine);
  (findAllAssignments as unknown as Mock).mockResolvedValue(all);
}

beforeEach(() => vi.clearAllMocks());

describe("POST /api/tech/jobs/[id]/status", () => {
  it("403 PREVIEW_READ_ONLY for a preview session even if the proxy is bypassed; nothing written", async () => {
    as(T1, [row()], [row()]);
    (getTechSession as unknown as Mock).mockResolvedValue({ userId: T1, organizationId: "org", preview: { adminUserId: "a", exp: 9_999_999_999 } });
    const res = await post({ action: "en_route" });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("PREVIEW_READ_ONLY");
    expect(findReadableJob).not.toHaveBeenCalled();
    expect(applyTechAction).not.toHaveBeenCalled();
  });

  it("400 INVALID_INPUT for cancelled and scheduled (not technician actions)", async () => {
    as(T1, [row()], [row()]);
    for (const action of ["cancelled", "scheduled"]) {
      const res = await post({ action });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_INPUT");
      expect(body.error.message).toBe("That isn't a technician action.");
    }
  });

  it("400 for the retired { status } body and for a missing appointmentId", async () => {
    as(T1, [row()], [row()]);
    expect((await post({ status: "in_progress" })).status).toBe(400);
    const res = await POST(new Request("http://t/api", { method: "POST", body: JSON.stringify({ action: "en_route" }) }) as never, ctx as never);
    expect(res.status).toBe(400);
    expect(applyTechAction).not.toHaveBeenCalled();
  });

  it("400 for a hold without a reason", async () => {
    as(T1, [row()], [row()]);
    const res = await post({ action: "on_hold" });
    expect(res.status).toBe(400);
    expect(holdVisit).not.toHaveBeenCalled();
  });

  it("404 when the job is not readable", async () => {
    as(T1, [], []);
    (findReadableJob as unknown as Mock).mockResolvedValue(null);
    const res = await post({ action: "en_route" });
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("This job isn't yours to update.");
  });

  it("409 MANAGED_EXTERNALLY on a synced job", async () => {
    as(T1, [row()], [row()], "in_progress", false);
    const res = await post({ action: "en_route" });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("MANAGED_EXTERNALLY");
  });

  it("404 for an appointmentId that is not mine", async () => {
    as(T1, [row()], [row()]);
    expect((await post({ action: "en_route", appointmentId: "55555555-5555-4555-8555-555555555555" })).status).toBe(404);
  });

  it("403 NOT_LEAD for a helper's close-out", async () => {
    as(T2, [helper], [row(), helper]);
    const res = await post({ action: "close_out" });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("NOT_LEAD");
    expect(closeOutRequest).not.toHaveBeenCalled();
  });

  it("a helper's pause writes the row on hold", async () => {
    as(T2, [helper], [row(), helper]);
    (applyTechAction as unknown as Mock).mockResolvedValue({ ok: true, assignmentStatus: "on_hold", requestStatus: "in_progress", requestBehind: false });
    const res = await post({ action: "pause" });
    expect(res.status).toBe(200);
    expect((applyTechAction as unknown as Mock).mock.calls[0]![0].resolved).toMatchObject({ kind: "write", assignmentTo: "on_hold" });
  });

  it("the active lead's close-out with nobody else open asks for a review once", async () => {
    as(T1, [row()], [row(), row({ assignmentId: "row-2", isLead: false, technicianId: T2, status: "completed" })]);
    (closeOutRequest as unknown as Mock).mockResolvedValue({ ok: true, changed: true, assignmentStatus: "completed" });
    const res = await post({ action: "close_out" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ assignmentStatus: "completed", requestStatus: "completed", changed: true });
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("the lead's done while a helper is open is the lead's own done", async () => {
    as(T1, [row()], [row(), helper]);
    (applyTechAction as unknown as Mock).mockResolvedValue({ ok: true, assignmentStatus: "completed", requestStatus: "in_progress", requestBehind: false });
    expect((await post({ action: "completed" })).status).toBe(200);
    expect(closeOutRequest).not.toHaveBeenCalled();
    expect((applyTechAction as unknown as Mock).mock.calls[0]![0].resolved).toMatchObject({ assignmentTo: "completed", timeEntry: "close" });
  });

  it("a solo active lead's response offers close_out, not done", async () => {
    as(T1, [row({ status: "arrived", startedAt: null })], [row({ status: "arrived", startedAt: null })], "arrived");
    (applyTechAction as unknown as Mock).mockResolvedValue({ ok: true, assignmentStatus: "in_progress", requestStatus: "in_progress", requestBehind: false });
    const res = await post({ action: "in_progress" });
    expect(res.status).toBe(200);
    const actions = (await res.json()).data.allowedActions as string[];
    expect(actions).toContain("close_out");
    expect(actions).not.toContain("completed");
  });

  it("a replayed close-out on a completed request is a 200 no-op with changed false", async () => {
    as(T1, [row({ status: "completed", completedAt: new Date() })], [row({ status: "completed", completedAt: new Date() })], "completed");
    const res = await post({ action: "close_out" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ assignmentStatus: "completed", requestStatus: "completed", changed: false, allowedActions: [] });
    expect(closeOutRequest).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("a close-out that changed nothing (raced) asks for no review", async () => {
    as(T1, [row()], [row()]);
    (closeOutRequest as unknown as Mock).mockResolvedValue({ ok: true, changed: false, assignmentStatus: "completed" });
    const res = await post({ action: "close_out" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.changed).toBe(false);
    expect(after).not.toHaveBeenCalled();
  });

  it("409 CLOSE_OUT_BLOCKED carries the blockers and the row status", async () => {
    as(T1, [row()], [row(), helper]);
    const blockers = [{ kind: "technician_open", technicianName: "Bo", technicianId: T2, appointmentNumber: 1 }];
    (closeOutRequest as unknown as Mock).mockResolvedValue({ ok: false, assignmentStatus: "completed", blockers });
    const res = await post({ action: "close_out" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CLOSE_OUT_BLOCKED");
    expect(body.error.details).toEqual({ assignmentStatus: "completed", blockers });
    expect(after).not.toHaveBeenCalled();
  });

  it("409 REQUEST_NOT_STARTED from the writer when only the request's state blocks", async () => {
    as(T1, [row()], [row()]);
    (closeOutRequest as unknown as Mock).mockResolvedValue({ ok: false, assignmentStatus: "arrived", blockers: [{ kind: "request_not_started", status: "arrived" }] });
    const res = await post({ action: "close_out" });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("REQUEST_NOT_STARTED");
  });

  it("409 STALE when the write lost the race", async () => {
    as(T2, [row({ isLead: false, technicianId: T2, status: "arrived", startedAt: null })], [row()]);
    (applyTechAction as unknown as Mock).mockResolvedValue({ ok: false, reason: "stale" });
    const res = await post({ action: "in_progress" });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("STALE");
  });

  it("409 STALE when expectedStatus differs from the server-read row, before any write", async () => {
    as(T2, [row({ isLead: false, technicianId: T2, status: "arrived", startedAt: null })], [row()]);
    const res = await post({ action: "in_progress", expectedStatus: "en_route" });
    expect(res.status).toBe(409);
    expect(await code(res)).toBe("STALE");
    expect(applyTechAction).not.toHaveBeenCalled();
  });

  it("a matching expectedStatus writes with the server-read row", async () => {
    as(T2, [row({ isLead: false, technicianId: T2, status: "arrived", startedAt: null })], [row()]);
    (applyTechAction as unknown as Mock).mockResolvedValue({ ok: true, assignmentStatus: "in_progress", requestStatus: "in_progress", requestBehind: false });
    expect((await post({ action: "in_progress", expectedStatus: "arrived" })).status).toBe(200);
    expect((applyTechAction as unknown as Mock).mock.calls[0]![0].row.status).toBe("arrived");
  });

  it("409 INVALID_TRANSITION for an illegal step, with a remedy", async () => {
    as(T2, [row({ isLead: false, technicianId: T2, status: "assigned", enRouteAt: null, arrivedAt: null, startedAt: null })], [row()]);
    const res = await post({ action: "arrived" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_TRANSITION");
    expect(body.error.message).toBe("That change isn't allowed right now. Refresh and try again.");
  });

  it("the active lead's hold goes to holdVisit with the reason", async () => {
    as(T1, [row()], [row(), helper]);
    (holdVisit as unknown as Mock).mockResolvedValue({ ok: true });
    const res = await post({ action: "on_hold", holdReason: "awaiting_parts" });
    expect(res.status).toBe(200);
    expect(holdVisit).toHaveBeenCalledWith(expect.objectContaining({ appointmentId: A1, holdReason: "awaiting_parts", requestStatus: "in_progress", actorUserId: T1 }));
    expect((await res.json()).data).toMatchObject({ assignmentStatus: "completed", requestStatus: "on_hold" });
  });

  it("a replayed tap is a 200 no-op with no write", async () => {
    as(T2, [helper], [row(), helper]);
    const res = await post({ action: "in_progress" });
    expect(res.status).toBe(200);
    expect(applyTechAction).not.toHaveBeenCalled();
  });
});
