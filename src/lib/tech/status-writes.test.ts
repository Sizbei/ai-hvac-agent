import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Pure test: @/lib/db is mocked. db.execute hands back the SQL it was given so
// db.batch captures the rendered statements; db.select resolves queued rows.
const { selectQueue, batch, recordStatusEvent } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  batch: vi.fn(),
  recordStatusEvent: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const chain = () => {
    const rows = Promise.resolve(selectQueue.shift() ?? []);
    const node: Record<string, unknown> = {
      from: () => node,
      where: () => node,
      innerJoin: () => node,
      orderBy: () => node,
      limit: () => rows,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => rows.then(ok, err),
    };
    return node;
  };
  return { db: { select: () => chain(), execute: (q: unknown) => q, batch } };
});
vi.mock("@/lib/admin/status-events", () => ({ recordStatusEvent }));

import {
  applyTechAction,
  closeOutBlockers,
  closeOutRequest,
  completeRequestFromAdmin,
  holdVisit,
} from "./status-writes";
import type { TechAssignmentRow } from "./ownership";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333333";
const T2 = "44444444-4444-4444-8444-444444444444";
const A1 = "55555555-5555-4555-8555-555555555555";
const ROW1 = "66666666-6666-4666-8666-666666666666";
const ROW2 = "77777777-7777-4777-8777-777777777777";
const A2 = "88888888-8888-4888-8888-888888888888";

const dialect = new PgDialect();
const render = (q: unknown): string => dialect.sqlToQuery(q as SQL).sql;
const statements = (): string[] => (batch.mock.calls[0]![0] as unknown[]).map((q) => render(q).replace(/\s+/g, " "));

const row = (over: Partial<TechAssignmentRow> = {}): TechAssignmentRow => ({
  assignmentId: ROW1, appointmentId: A1, appointmentNumber: 1, isLead: true, status: "arrived",
  cancelledAt: null, enRouteAt: new Date(), arrivedAt: new Date(), startedAt: null, completedAt: null,
  technicianId: T1, ...over,
});

const res = (...rowSets: unknown[][]) => rowSets.map((rows) => ({ rows }));

beforeEach(() => {
  selectQueue.length = 0;
  batch.mockReset();
  recordStatusEvent.mockReset();
});

describe("applyTechAction", () => {
  const base = { organizationId: ORG, techUserId: T1, requestId: REQ, activeVisitId: A1 };

  it("lead in_progress: lock, CAS, xmin-gated request UPDATE, auto entry", async () => {
    batch.mockResolvedValue(res([], [{ id: ROW1 }], [{ status: "in_progress" }], []));
    const out = await applyTechAction({
      ...base, row: row(), requestStatus: "arrived",
      resolved: { kind: "write", assignmentTo: "in_progress", stamp: "startedAt", requestTo: "in_progress", timeEntry: "open" },
    });
    const s = statements();
    expect(s).toHaveLength(4);
    expect(s[0]).toMatch(/^SELECT 1 FROM service_requests WHERE id = \$1::uuid AND organization_id = \$2::uuid FOR NO KEY UPDATE$/);
    expect(s[1]).toMatch(/UPDATE appointment_assignments SET status = \$\d+::request_status, started_at = COALESCE\(started_at, now\(\)\)/);
    expect(s[1]).toMatch(/status = \$\d+::request_status RETURNING id/);
    expect(s[2]).toMatch(/UPDATE service_requests SET status = \$\d+::request_status, completed_at = NULL, hold_reason = NULL, follow_up_date = NULL/);
    expect(s[2]).toMatch(/fieldpulse_job_id IS NULL AND hcp_job_id IS NULL/);
    expect(s[2]).toContain("pg_current_xact_id");
    expect(s[3]).toContain("ON CONFLICT (service_request_id, technician_id) WHERE clock_out_at IS NULL DO NOTHING");
    expect(s[3]).toContain("pg_current_xact_id");
    expect(out).toEqual({ ok: true, assignmentStatus: "in_progress", requestStatus: "in_progress", requestBehind: false });
    expect(recordStatusEvent).toHaveBeenCalledWith({
      organizationId: ORG, serviceRequestId: REQ, fromStatus: "arrived", toStatus: "in_progress", actorType: "human", actorId: T1,
    });
  });

  it("helper in_progress: three statements and no service_requests UPDATE", async () => {
    batch.mockResolvedValue(res([], [{ id: ROW2 }], []));
    const out = await applyTechAction({
      ...base, techUserId: T2, row: row({ assignmentId: ROW2, isLead: false, technicianId: T2 }), requestStatus: "in_progress",
      resolved: { kind: "write", assignmentTo: "in_progress", stamp: "startedAt", requestTo: null, timeEntry: "open" },
    });
    const s = statements();
    expect(s).toHaveLength(3);
    expect(s.some((q) => q.includes("UPDATE service_requests"))).toBe(false);
    expect(s[2]).toContain("INSERT INTO technician_time_entries");
    expect(s[2]).toContain("pg_current_xact_id");
    expect(out).toMatchObject({ ok: true, requestBehind: false });
    expect(recordStatusEvent).not.toHaveBeenCalled();
  });

  it("done closes only my entry, gated on this transaction's row write", async () => {
    batch.mockResolvedValue(res([], [{ id: ROW2 }], []));
    await applyTechAction({
      ...base, techUserId: T2, row: row({ assignmentId: ROW2, isLead: false, technicianId: T2, status: "in_progress", startedAt: new Date() }),
      requestStatus: "in_progress",
      resolved: { kind: "write", assignmentTo: "completed", stamp: "completedAt", requestTo: null, timeEntry: "close" },
    });
    const s = statements();
    expect(s[1]).toContain("completed_at = COALESCE(completed_at, now())");
    expect(s[2]).toMatch(/^UPDATE technician_time_entries t SET clock_out_at = now\(\)/);
    expect(s[2]).toContain("pg_current_xact_id");
  });

  it("pause writes no stamp and no entry", async () => {
    batch.mockResolvedValue(res([], [{ id: ROW2 }]));
    await applyTechAction({
      ...base, row: row({ isLead: false }), requestStatus: "arrived",
      resolved: { kind: "write", assignmentTo: "on_hold", stamp: null, requestTo: null, timeEntry: "none" },
    });
    const s = statements();
    expect(s).toHaveLength(2);
    expect(s[1]).toMatch(/SET status = \$\d+::request_status WHERE/);
  });

  it("a later-visit lead is told the request is behind", async () => {
    batch.mockResolvedValue(res([], [{ id: ROW1 }], []));
    const out = await applyTechAction({
      ...base, activeVisitId: A2, row: row(), requestStatus: "in_progress",
      resolved: { kind: "write", assignmentTo: "in_progress", stamp: "startedAt", requestTo: null, timeEntry: "open" },
    });
    expect(out).toMatchObject({ ok: true, requestBehind: true });
  });

  it("stale CAS: re-read at the target is a no-op, elsewhere is stale", async () => {
    const write = { kind: "write", assignmentTo: "in_progress", stamp: "startedAt", requestTo: "in_progress", timeEntry: "open" } as const;
    batch.mockResolvedValue(res([], [], [], []));
    selectQueue.push([{ status: "in_progress", enRouteAt: null, arrivedAt: null, startedAt: new Date(), completedAt: null }], [{ status: "arrived", native: true }]);
    expect(await applyTechAction({ ...base, row: row(), requestStatus: "arrived", resolved: write }))
      .toEqual({ ok: true, assignmentStatus: "in_progress", requestStatus: "arrived", requestBehind: true });
    // the concurrent winner already moved the request
    selectQueue.push([{ status: "in_progress", enRouteAt: null, arrivedAt: null, startedAt: new Date(), completedAt: null }], [{ status: "in_progress", native: true }]);
    expect(await applyTechAction({ ...base, row: row(), requestStatus: "arrived", resolved: write }))
      .toEqual({ ok: true, assignmentStatus: "in_progress", requestStatus: "in_progress", requestBehind: false });
    selectQueue.push([{ status: "completed", enRouteAt: null, arrivedAt: null, startedAt: new Date(), completedAt: new Date() }]);
    expect(await applyTechAction({ ...base, row: row(), requestStatus: "arrived", resolved: write }))
      .toEqual({ ok: false, reason: "stale" });
    expect(recordStatusEvent).not.toHaveBeenCalled();
  });

  it("request_only: lock + request UPDATE gated on the row being at the target", async () => {
    batch.mockResolvedValue(res([], [{ status: "in_progress" }]));
    const out = await applyTechAction({
      ...base, row: row({ status: "in_progress", startedAt: new Date() }), requestStatus: "arrived",
      resolved: { kind: "request_only", requestTo: "in_progress" },
    });
    const s = statements();
    expect(s).toHaveLength(2);
    expect(s[0]).toContain("FOR NO KEY UPDATE");
    expect(s[1]).toMatch(/UPDATE service_requests SET status/);
    expect(s[1]).toMatch(/a\.status = \$\d+::request_status/);
    expect(s[1]).not.toContain("pg_current_xact_id");
    expect(out).toEqual({ ok: true, assignmentStatus: "in_progress", requestStatus: "in_progress", requestBehind: false });
    expect(recordStatusEvent).toHaveBeenCalledTimes(1);
  });

  it("request_only that lands nothing is still 200 with requestBehind", async () => {
    batch.mockResolvedValue(res([], []));
    const out = await applyTechAction({
      ...base, row: row({ status: "in_progress", startedAt: new Date() }), requestStatus: "arrived",
      resolved: { kind: "request_only", requestTo: "in_progress" },
    });
    expect(out).toMatchObject({ ok: true, requestBehind: true, requestStatus: "arrived" });
    expect(recordStatusEvent).not.toHaveBeenCalled();
  });

  it("a deadlock maps to stale", async () => {
    batch.mockRejectedValue(Object.assign(new Error("q"), { cause: { code: "40P01" } }));
    expect(await applyTechAction({
      ...base, row: row(), requestStatus: "arrived",
      resolved: { kind: "write", assignmentTo: "in_progress", stamp: "startedAt", requestTo: null, timeEntry: "none" },
    })).toEqual({ ok: false, reason: "stale" });
  });
});

describe("closeOutRequest", () => {
  const input = { organizationId: ORG, techUserId: T1, requestId: REQ, row: row({ status: "in_progress", startedAt: new Date() }) };

  it("lock, my row done, guarded request completion, my entry closed after my done", async () => {
    batch.mockResolvedValue(res([], [{ id: ROW1 }], [{ from_status: "in_progress" }], []));
    expect(await closeOutRequest(input)).toEqual({ ok: true, changed: true, assignmentStatus: "completed" });
    const s = statements();
    expect(s).toHaveLength(4);
    expect(s[0]).toContain("FOR NO KEY UPDATE");
    expect(s[1]).toMatch(/SET status = 'completed'::request_status, completed_at = COALESCE\(completed_at, now\(\)\)/);
    expect(s[1]).toContain("started_at IS NOT NULL");
    expect(s[1]).toContain("r.status IN ('in_progress'::request_status, 'on_hold'::request_status)");
    expect(s[2]).toMatch(/^WITH prev AS \(SELECT status FROM service_requests WHERE id = \$1::uuid AND organization_id = \$2::uuid FOR NO KEY UPDATE\)/);
    expect(s[2]).toContain("completed_at = now()");
    expect(s[2]).toContain("hold_reason = NULL");
    expect(s[2]).toContain("NOT EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = $");
    expect(s[2]).toContain("p.cancelled_at IS NULL");
    expect(s[2]).toContain("RETURNING prev.status AS from_status");
    expect(s[3]).toMatch(/^UPDATE technician_time_entries/);
    expect(s[3]).toContain("a.status = 'completed'::request_status");
    expect(recordStatusEvent).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: "in_progress", toStatus: "completed", actorId: T1 }));
  });

  it("already completed by a concurrent close-out: changed false, no event", async () => {
    batch.mockResolvedValue(res([], [], [], []));
    selectQueue.push([{ status: "completed", native: true }], [{ status: "completed" }]);
    expect(await closeOutRequest(input)).toEqual({ ok: true, changed: false, assignmentStatus: "completed" });
    expect(recordStatusEvent).not.toHaveBeenCalled();
  });

  it("refused: carries my row's new status and the blockers", async () => {
    batch.mockResolvedValue(res([], [{ id: ROW1 }], [], []));
    selectQueue.push(
      [{ status: "in_progress", native: true }], // request re-read
      [{ status: "completed" }], // my row re-read
      [{ status: "in_progress" }], // closeOutBlockers: request
      [
        { assignmentId: ROW1, appointmentId: A1, appointmentNumber: 1, technicianId: T1, technicianName: "Ann", status: "completed", enRouteAt: null, arrivedAt: null, startedAt: new Date(), completedAt: new Date(), windowStart: null, scheduledDate: null },
        { assignmentId: ROW2, appointmentId: A1, appointmentNumber: 1, technicianId: T2, technicianName: "Bo", status: "in_progress", enRouteAt: null, arrivedAt: null, startedAt: new Date(), completedAt: null, windowStart: null, scheduledDate: null },
      ],
    );
    expect(await closeOutRequest(input)).toEqual({
      ok: false, assignmentStatus: "completed",
      blockers: [{ kind: "technician_open", technicianName: "Bo", technicianId: T2, appointmentNumber: 1 }],
    });
    expect(recordStatusEvent).not.toHaveBeenCalled();
  });
});

describe("closeOutBlockers", () => {
  const r = (over: Record<string, unknown>) => ({
    assignmentId: ROW2, appointmentId: A1, appointmentNumber: 1, technicianId: T2, technicianName: "Bo", status: "assigned",
    enRouteAt: null, arrivedAt: null, startedAt: null, completedAt: null, windowStart: null, scheduledDate: null, ...over,
  });

  it("my untouched row reads as not started; later untouched visits are planned; earlier visits are earlier", async () => {
    selectQueue.push([{ status: "assigned" }], [
      r({ assignmentId: ROW1, technicianId: T1, technicianName: "Ann", appointmentId: A2, appointmentNumber: 2 }),
      r({ appointmentNumber: 1, status: "in_progress", startedAt: new Date() }),
      r({ assignmentId: "x", appointmentId: "v3", appointmentNumber: 3, windowStart: new Date("2026-11-09T13:00:00.000Z") }),
    ]);
    expect(await closeOutBlockers(ORG, REQ, { technicianId: T1, appointmentId: A2 })).toEqual([
      { kind: "request_not_started", status: "assigned" },
      { kind: "earlier_visit_open", technicianName: "Bo", appointmentNumber: 1 },
      { kind: "visit_planned", appointmentNumber: 3, date: "2026-11-09T13:00:00.000Z" },
    ]);
  });

  it("my own started open row is not a blocker (close-out completes it)", async () => {
    selectQueue.push([{ status: "in_progress" }], [
      r({ assignmentId: ROW1, technicianId: T1, technicianName: "Ann", status: "in_progress", startedAt: new Date() }),
    ]);
    expect(await closeOutBlockers(ORG, REQ, { technicianId: T1, appointmentId: A1 })).toEqual([]);
  });
});

describe("holdVisit", () => {
  const input = {
    organizationId: ORG, actorUserId: T1, requestId: REQ, appointmentId: A1,
    holdReason: "awaiting_parts" as const, followUpDate: null, requestStatus: "in_progress" as const,
  };

  it("refuses a request that cannot go on hold without writing", async () => {
    expect(await holdVisit({ ...input, requestStatus: "pending" })).toEqual({ ok: false, reason: "invalid_transition" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("locks request then visit, ends the rows, holds the request, closes entries, ends an untouched visit", async () => {
    batch.mockResolvedValue(res([], [], [{ id: ROW1, technician_id: T1 }], [{ from_status: "in_progress" }], [], []));
    expect(await holdVisit(input)).toEqual({ ok: true });
    const s = statements();
    expect(s).toHaveLength(6);
    expect(s[0]).toMatch(/^SELECT 1 FROM service_requests .* FOR NO KEY UPDATE$/);
    expect(s[1]).toMatch(/^SELECT 1 FROM appointments WHERE id = \$1::uuid AND organization_id = \$2::uuid FOR NO KEY UPDATE$/);
    expect(s[2]).toContain("SET status = CASE WHEN (en_route_at IS NOT NULL OR arrived_at IS NOT NULL OR started_at IS NOT NULL OR completed_at IS NOT NULL) THEN 'completed'::request_status ELSE 'cancelled'::request_status END");
    expect(s[2]).toContain("RETURNING id, technician_id");
    expect(s[2]).toContain("r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL");
    expect(s[3]).toMatch(/^WITH prev AS \(SELECT status FROM service_requests/);
    expect(s[3]).toContain("SET status = 'on_hold'::request_status, hold_reason = $");
    expect(s[3]).toContain("NOT EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.appointment_id = $");
    expect(s[3]).toContain("RETURNING prev.status AS from_status");
    // no expected-status CAS on the request: the lock serialises writers
    expect(s[3]).not.toMatch(/s\.status = \$/);
    expect(s[4]).toMatch(/^UPDATE technician_time_entries/);
    expect(s[4]).toContain("NOT EXISTS");
    // entries close for technicians who worked this visit, not rows cancelled untouched
    expect(s[4]).toContain("t.technician_id IN (SELECT a.technician_id FROM appointment_assignments a");
    expect(s[4]).toContain("(a.status <> 'cancelled'::request_status OR (a.en_route_at IS NOT NULL OR");
    expect(s[5]).toMatch(/^UPDATE appointments SET cancelled_at = now\(\), version = version \+ 1, updated_at = now\(\)/);
    expect(s[5]).toContain("a.status <> 'cancelled'::request_status");
    expect(s[2]).toContain("status IN ('assigned'::request_status,");
    expect(recordStatusEvent).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: "in_progress", toStatus: "on_hold", actorId: T1 }));
  });

  it("no active visit: lock + the request UPDATE without the row gate", async () => {
    batch.mockResolvedValue(res([], [{ from_status: "scheduled" }]));
    expect(await holdVisit({ ...input, appointmentId: null, requestStatus: "scheduled" })).toEqual({ ok: true });
    const s = statements();
    expect(s).toHaveLength(2);
    expect(s[1]).toContain("hold_reason");
    expect(s[1]).not.toContain("NOT EXISTS");
  });

  it("0 rows: already on hold is idempotent, anything else is stale", async () => {
    batch.mockResolvedValue(res([], [], [], [], [], []));
    selectQueue.push([{ status: "on_hold", native: true }]);
    expect(await holdVisit(input)).toEqual({ ok: true });
    selectQueue.push([{ status: "completed", native: true }]);
    expect(await holdVisit(input)).toEqual({ ok: false, reason: "stale" });
    expect(recordStatusEvent).not.toHaveBeenCalled();
  });
});

describe("completeRequestFromAdmin", () => {
  const input = { organizationId: ORG, actorUserId: T2, requestId: REQ };

  it("lock, guarded completion, untouched rows cancelled and entries closed on the request xmin", async () => {
    batch.mockResolvedValue(res([], [{ from_status: "on_hold" }], [], []));
    expect(await completeRequestFromAdmin(input)).toEqual({ ok: true, changed: true });
    const s = statements();
    expect(s).toHaveLength(4);
    expect(s[0]).toContain("FOR NO KEY UPDATE");
    expect(s[1]).toMatch(/^WITH prev AS/);
    expect(s[1]).toContain("completed_at = now()");
    expect(s[1]).toContain("(a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)");
    expect(s[2]).toMatch(/^UPDATE appointment_assignments a SET status = 'cancelled'::request_status FROM appointments p/);
    expect(s[2]).toContain("r.xmin = pg_current_xact_id()::xid");
    expect(s[3]).toMatch(/^UPDATE technician_time_entries/);
    expect(s[3]).toContain("r.xmin = pg_current_xact_id()::xid");
    expect(recordStatusEvent).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: "on_hold", toStatus: "completed", actorType: "human", actorId: T2 }));
  });

  it("0 rows: a working technician blocks, a wrong status is an invalid transition", async () => {
    batch.mockResolvedValue(res([], [], [], []));
    selectQueue.push([{ status: "in_progress", native: true }], [
      { assignmentId: ROW1, appointmentId: A1, appointmentNumber: 1, technicianId: T1, technicianName: "Ann", status: "in_progress", enRouteAt: null, arrivedAt: null, startedAt: new Date(), completedAt: null, windowStart: null, scheduledDate: null },
      { assignmentId: ROW2, appointmentId: A1, appointmentNumber: 1, technicianId: T2, technicianName: "Bo", status: "assigned", enRouteAt: null, arrivedAt: null, startedAt: null, completedAt: null, windowStart: null, scheduledDate: null },
    ]);
    expect(await completeRequestFromAdmin(input)).toEqual({
      ok: false, reason: "blocked",
      blockers: [{ kind: "technician_open", technicianName: "Ann", technicianId: T1, appointmentNumber: 1 }],
    });
    selectQueue.push([{ status: "assigned", native: true }]);
    expect(await completeRequestFromAdmin(input)).toEqual({ ok: false, reason: "invalid_transition", currentStatus: "assigned" });
  });
});
