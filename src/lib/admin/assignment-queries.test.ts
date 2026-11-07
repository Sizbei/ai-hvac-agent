import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Pure test: @/lib/db and the visit helpers are mocked.
const m = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  executed: [] as unknown[],
  batch: vi.fn(),
  execute: vi.fn(),
  getAppointment: vi.fn(),
  activeTechnicianIds: vi.fn(),
  anyTimeOff: vi.fn(),
  noTimeOff: vi.fn(),
}));

vi.mock("@/lib/db", () => {
  const chain = () => {
    const rows = Promise.resolve(m.selectQueue.shift() ?? []);
    const node: Record<string, unknown> = { from: () => node, where: () => node, innerJoin: () => node, limit: () => rows };
    return node;
  };
  return { db: { select: () => chain(), execute: (q: unknown) => { m.executed.push(q); return m.execute(q); }, batch: m.batch } };
});
vi.mock("./appointment-queries", () => ({
  getAppointment: m.getAppointment,
  activeTechnicianIds: m.activeTechnicianIds,
  anyTimeOff: m.anyTimeOff,
  noTimeOff: m.noTimeOff,
}));

import { addVisitTechnician, removeVisitTechnician } from "./assignment-queries";

const ORG = "00000000-0000-0000-0000-000000000001";
const RID = "11111111-1111-1111-1111-111111111111";
const AID = "22222222-2222-2222-2222-222222222222";
const TID = "33333333-3333-3333-3333-333333333333";
const ACTOR = "44444444-4444-4444-4444-444444444444";

function visit(over: Record<string, unknown> = {}) {
  return {
    id: AID, serviceRequestId: RID, appointmentNumber: 1, scheduledDate: null, startsAt: "2026-11-02T14:00:00.000Z",
    endsAt: "2026-11-02T16:00:00.000Z", arrivalWindowStart: null, arrivalWindowEnd: null, isConfirmed: false,
    cancelledAt: null, specialInstructions: null, version: 0,
    assignments: [{ technicianId: "lead", technicianName: "L", isLead: true, status: "assigned" }], ...over,
  };
}
const reqRow = (over: Record<string, unknown> = {}) => ({ status: "assigned", fp: null, hcp: null, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  m.selectQueue.length = 0;
  m.executed.length = 0;
  m.activeTechnicianIds.mockResolvedValue([TID]);
  m.anyTimeOff.mockResolvedValue(false);
  m.noTimeOff.mockReturnValue({ kind: "noTimeOff" });
});

describe("addVisitTechnician", () => {
  it("not_found when the visit is not on the request", async () => {
    m.getAppointment.mockResolvedValueOnce(null);
    expect(await addVisitTechnician(ORG, RID, AID, TID, ACTOR)).toEqual({ reason: "not_found" });
    expect(m.batch).not.toHaveBeenCalled();
  });

  it("technician_not_found when the technician is not active in the org", async () => {
    m.getAppointment.mockResolvedValueOnce(visit());
    m.activeTechnicianIds.mockResolvedValueOnce([]);
    expect(await addVisitTechnician(ORG, RID, AID, TID, ACTOR)).toEqual({ reason: "technician_not_found" });
    expect(m.batch).not.toHaveBeenCalled();
  });

  it("runs ONE batch: request lock FOR NO KEY UPDATE, then one statement (insert-or-revive + version bump)", async () => {
    const after = visit({ assignments: [] });
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(after);
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    expect(await addVisitTechnician(ORG, RID, AID, TID, ACTOR)).toBe(after);
    expect(m.batch).toHaveBeenCalledTimes(1);
    expect(m.batch.mock.calls[0][0]).toHaveLength(2);
    const [lock, write] = m.executed.map((q) => new PgDialect().sqlToQuery(q as SQL).sql.replace(/\s+/g, " "));
    expect(lock).toBe("SELECT 1 FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
    expect(write).toContain("'assigned'::request_status");
    expect(write).toContain("cancelled_at IS NULL");
  });

  it("revives a cancelled non-lead row clean instead of DO NOTHING", async () => {
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(visit());
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    await addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    const write = new PgDialect().sqlToQuery(m.executed[1] as SQL).sql.replace(/\s+/g, " ");
    expect(write).toContain("ON CONFLICT (appointment_id, technician_id) DO UPDATE SET status = 'assigned'::request_status, assigned_by = EXCLUDED.assigned_by, assigned_at = now(), en_route_at = NULL, arrived_at = NULL, started_at = NULL, completed_at = NULL WHERE appointment_assignments.status = 'cancelled'::request_status AND NOT appointment_assignments.is_lead RETURNING id");
  });

  it("requires a live lead and an open row; enforces the five-technician cap in SQL; all org-bound", async () => {
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(visit());
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    await addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    const { sql: text, params } = new PgDialect().sqlToQuery(m.executed[1] as SQL);
    const t = text.replace(/\s+/g, " ");
    expect(t).toMatch(/AND EXISTS \(SELECT 1 FROM appointment_assignments x WHERE x\.appointment_id = \$\d+::uuid AND x\.organization_id = \$\d+::uuid AND x\.status IN \([^)]*\)\)/);
    expect(t).toMatch(/AND EXISTS \(SELECT 1 FROM appointment_assignments l WHERE l\.appointment_id = \$\d+::uuid AND l\.organization_id = \$\d+::uuid AND l\.is_lead AND l\.status <> 'cancelled'::request_status\)/);
    expect(t).toMatch(/AND \(SELECT count\(\*\) FROM appointment_assignments c WHERE c\.appointment_id = \$\d+::uuid AND c\.organization_id = \$\d+::uuid AND c\.status <> 'cancelled'::request_status AND c\.technician_id <> \$\d+::uuid\) < \$\d+::int/);
    expect(params).toContain(5);
    expect(params.filter((p) => p === ORG).length).toBeGreaterThanOrEqual(6);
  });

  it("bumps the visit's version in the same statement, only when a row was written", async () => {
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(visit());
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    await addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    const t = new PgDialect().sqlToQuery(m.executed[1] as SQL).sql.replace(/\s+/g, " ");
    expect(t).toMatch(/^WITH ins AS \(INSERT INTO appointment_assignments/);
    expect(t).toContain("bump AS (UPDATE appointments SET version = version + 1, updated_at = now() WHERE id = $");
    expect(t).toContain("AND EXISTS (SELECT 1 FROM ins) RETURNING id) SELECT id FROM ins");
  });

  it("pins the request and visit predicates (org, request id) inside the insert and the bump", async () => {
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(visit());
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    await addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    const { sql: text, params } = new PgDialect().sqlToQuery(m.executed[1] as SQL);
    const t = text.replace(/\s+/g, " ");
    expect(t).toMatch(/WHERE EXISTS \(SELECT 1 FROM service_requests r WHERE r\.id = \$\d+::uuid AND r\.organization_id = \$\d+::uuid AND r\.fieldpulse_job_id IS NULL/);
    expect(t).toMatch(/AND EXISTS \(SELECT 1 FROM appointments p WHERE p\.id = \$\d+::uuid AND p\.service_request_id = \$\d+::uuid AND p\.organization_id = \$\d+::uuid AND p\.cancelled_at IS NULL\)/);
    expect(t).toMatch(/bump AS \(UPDATE appointments SET version = version \+ 1, updated_at = now\(\) WHERE id = \$\d+::uuid AND organization_id = \$\d+::uuid AND EXISTS/);
    expect(params).toContain(RID);
  });

  it("reads the time-off window from the appointments row inside the INSERT", async () => {
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(visit());
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    await addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    const insert = new PgDialect().sqlToQuery(m.executed[1] as SQL).sql.replace(/\s+/g, " ");
    expect(insert).toContain("FROM appointments p JOIN technician_shifts s");
    expect(insert).toContain("COALESCE(p.starts_at, p.arrival_window_start,");
    expect(insert).toContain("COALESCE(p.ends_at, p.arrival_window_end,");
    expect(insert).toContain("p.scheduled_date AT TIME ZONE $");
    expect(insert).toContain("s.removes_capacity");
    expect(m.noTimeOff).not.toHaveBeenCalled();
  });

  describe("classifies a 0-row insert", () => {
    const miss = async (v: Record<string, unknown>, r: Record<string, unknown> = {}) => {
      m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(visit(v));
      m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [] }]);
      m.selectQueue.push([reqRow(r)]);
      return addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    };
    it("already_assigned (incl. the lead)", async () => {
      expect(await miss({ assignments: [{ technicianId: TID, technicianName: "T", isLead: true, status: "assigned" }] }))
        .toEqual({ reason: "already_assigned" });
    });
    it("visit_ended when rows exist but none is open", async () => {
      expect(await miss({ assignments: [{ technicianId: "x", technicianName: "X", isLead: true, status: "completed" }] }))
        .toEqual({ reason: "visit_ended" });
    });
    it("request_completed", async () => {
      expect(await miss({}, { status: "completed" })).toEqual({ reason: "request_completed" });
    });
    it("request_cancelled", async () => {
      expect(await miss({}, { status: "cancelled" })).toEqual({ reason: "request_cancelled" });
    });
    it("visit_cancelled", async () => {
      expect(await miss({ cancelledAt: "2026-11-01T00:00:00.000Z" })).toEqual({ reason: "visit_cancelled" });
    });
    it("managed_externally for a FieldPulse or Housecall Pro request", async () => {
      expect(await miss({}, { fp: "fp-1" })).toEqual({ reason: "managed_externally" });
      expect(await miss({}, { hcp: "hcp-1" })).toEqual({ reason: "managed_externally" });
    });
    it("time_off", async () => {
      m.anyTimeOff.mockResolvedValueOnce(true);
      expect(await miss({})).toEqual({ reason: "time_off" });
    });
    it("no_lead when the visit has no live lead", async () => {
      expect(await miss({ assignments: [] })).toEqual({ reason: "no_lead" });
      expect(await miss({ assignments: [{ technicianId: "x", technicianName: "X", isLead: false, status: "assigned" }] })).toEqual({ reason: "no_lead" });
    });
    it("visit_full at five live technicians", async () => {
      const five = ["l", "a", "b", "c", "d"].map((id, i) => ({ technicianId: id, technicianName: id, isLead: i === 0, status: "assigned" }));
      expect(await miss({ assignments: five })).toEqual({ reason: "visit_full" });
    });
    it("a cancelled row of the same technician is not already_assigned", async () => {
      m.anyTimeOff.mockResolvedValueOnce(true);
      expect(await miss({ assignments: [
        { technicianId: "lead", technicianName: "L", isLead: true, status: "assigned" },
        { technicianId: TID, technicianName: "T", isLead: false, status: "cancelled" },
      ] })).toEqual({ reason: "time_off" });
    });
  });
});

describe("removeVisitTechnician", () => {
  const removed = (deleted: number, cancelled: number) => m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ deleted, cancelled }] }]);

  it("one batch: lock, then delete-untouched / cancel-timestamped / bump in one statement", async () => {
    removed(1, 0);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ ok: true, cancelled: false });
    const [lock, write] = m.executed.map((q) => new PgDialect().sqlToQuery(q as SQL).sql.replace(/\s+/g, " "));
    expect(lock).toContain("FOR NO KEY UPDATE");
    expect(write).toContain("WITH del AS (DELETE FROM appointment_assignments a USING appointments p WHERE a.appointment_id = p.id AND p.id = $");
    expect(write).toContain("AND NOT a.is_lead AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = p.service_request_id AND r.organization_id = $");
    expect(write).toContain("'cancelled'::request_status)) AND a.status <> 'cancelled'::request_status AND NOT (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL) RETURNING a.id)");
    expect(write).toContain("can AS (UPDATE appointment_assignments a SET status = 'cancelled'::request_status FROM appointments p WHERE a.appointment_id = p.id");
    expect(write).toContain("AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL) AND NOT (a.status <> 'cancelled'::request_status AND (a.status IN ('en_route'::request_status,");
    expect(write).toContain("bump AS (UPDATE appointments SET version = version + 1, updated_at = now() WHERE id = $");
    expect(write).toContain("AND (EXISTS (SELECT 1 FROM del) OR EXISTS (SELECT 1 FROM can)) RETURNING id)");
    expect(write).toContain("r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL AND r.status NOT IN ('completed'::request_status, 'cancelled'::request_status)");
  });
  it("pins org, request, visit and the request's tenant in both the delete and the cancel, and the bump", async () => {
    removed(1, 0);
    await removeVisitTechnician(ORG, RID, AID, TID);
    const t = new PgDialect().sqlToQuery(m.executed[1] as SQL).sql.replace(/\s+/g, " ");
    const row = "a.appointment_id = p.id AND p.id = \\$\\d+::uuid AND p.service_request_id = \\$\\d+::uuid AND p.organization_id = \\$\\d+::uuid AND a.organization_id = \\$\\d+::uuid AND a.technician_id = \\$\\d+::uuid AND NOT a.is_lead AND EXISTS \\(SELECT 1 FROM service_requests r WHERE r.id = p.service_request_id AND r.organization_id = \\$\\d+::uuid AND r.fieldpulse_job_id IS NULL";
    expect((t.match(new RegExp(row, "g")) ?? []).length).toBe(2);
    expect(t).toMatch(/bump AS \(UPDATE appointments SET version = version \+ 1, updated_at = now\(\) WHERE id = \$\d+::uuid AND organization_id = \$\d+::uuid AND \(EXISTS/);
  });
  it("a timestamped helper who isn't started is cancelled, not deleted", async () => {
    removed(0, 1);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ ok: true, cancelled: true });
  });
  it("not_found when the technician has no live row on the visit", async () => {
    removed(0, 0);
    m.selectQueue.push([reqRow()], []);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "not_found" });
    removed(0, 0);
    m.selectQueue.push([reqRow()], [{ isLead: false, status: "cancelled" }]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "not_found" });
  });
  it("not_found when the request is not in the org", async () => {
    removed(0, 0);
    m.selectQueue.push([]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "not_found" });
  });
  it("managed_externally, request_completed, request_cancelled", async () => {
    removed(0, 0);
    m.selectQueue.push([reqRow({ fp: "fp-1" })]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "managed_externally" });
    removed(0, 0);
    m.selectQueue.push([reqRow({ status: "completed" })]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "request_completed" });
    removed(0, 0);
    m.selectQueue.push([reqRow({ status: "cancelled" })]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "request_cancelled" });
  });
  it("is_lead and has_progress", async () => {
    removed(0, 0);
    m.selectQueue.push([reqRow()], [{ isLead: true, status: "assigned" }]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "is_lead" });
    removed(0, 0);
    m.selectQueue.push([reqRow()], [{ isLead: false, status: "in_progress" }]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "has_progress" });
  });
});
