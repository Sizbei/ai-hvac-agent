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

  it("runs ONE batch (lock then guarded insert) and returns the refreshed visit", async () => {
    const after = visit({ assignments: [] });
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(after);
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    expect(await addVisitTechnician(ORG, RID, AID, TID, ACTOR)).toBe(after);
    expect(m.batch).toHaveBeenCalledTimes(1);
    expect(m.batch.mock.calls[0][0]).toHaveLength(2);
    const [lock, insert] = m.executed.map((q) => new PgDialect().sqlToQuery(q as SQL).sql);
    expect(lock).toContain("FOR SHARE");
    expect(insert).toContain("ON CONFLICT (appointment_id, technician_id) DO NOTHING");
    expect(insert).toContain("'assigned'::request_status");
    expect(insert).toContain("cancelled_at IS NULL");
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

  it("wraps the open-assignment OR group in parentheses", async () => {
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(visit());
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    await addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    const insert = new PgDialect().sqlToQuery(m.executed[1] as SQL).sql.replace(/\s+/g, " ");
    expect(insert).toMatch(/AND \(NOT EXISTS \(SELECT 1 FROM appointment_assignments x WHERE x\.appointment_id = \$\d+::uuid\) OR EXISTS \(SELECT 1 FROM appointment_assignments x WHERE x\.appointment_id = \$\d+::uuid AND x\.status IN \([^)]*\)\)\) AND NOT EXISTS/);
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
  });
});

describe("removeVisitTechnician", () => {
  it("deletes a helper with no progress, only on a native open request", async () => {
    m.execute.mockResolvedValueOnce({ rows: [{ id: "a" }] });
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ ok: true });
    const text = new PgDialect().sqlToQuery(m.executed[0] as SQL).sql.replace(/\s+/g, " ");
    expect(text).toContain("NOT a.is_lead");
    expect(text).toContain("a.started_at IS NULL");
    expect(text).toContain("EXISTS (SELECT 1 FROM service_requests r WHERE r.id = p.service_request_id AND r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL AND r.status NOT IN ('completed'::request_status, 'cancelled'::request_status))");
  });
  it("not_found when the technician has no row on the visit", async () => {
    m.execute.mockResolvedValueOnce({ rows: [] });
    m.selectQueue.push([reqRow()], []);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "not_found" });
  });
  it("not_found when the request is not in the org", async () => {
    m.execute.mockResolvedValueOnce({ rows: [] });
    m.selectQueue.push([]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "not_found" });
  });
  it("managed_externally for a synced request", async () => {
    m.execute.mockResolvedValueOnce({ rows: [] });
    m.selectQueue.push([reqRow({ fp: "fp-1" })]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "managed_externally" });
  });
  it("request_completed and request_cancelled", async () => {
    m.execute.mockResolvedValueOnce({ rows: [] });
    m.selectQueue.push([reqRow({ status: "completed" })]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "request_completed" });
    m.execute.mockResolvedValueOnce({ rows: [] });
    m.selectQueue.push([reqRow({ status: "cancelled" })]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "request_cancelled" });
  });
  it("is_lead", async () => {
    m.execute.mockResolvedValueOnce({ rows: [] });
    m.selectQueue.push([reqRow()], [{ isLead: true, enRouteAt: null, arrivedAt: null, startedAt: null, completedAt: null }]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "is_lead" });
  });
  it("has_progress", async () => {
    m.execute.mockResolvedValueOnce({ rows: [] });
    m.selectQueue.push([reqRow()], [{ isLead: false, enRouteAt: new Date(), arrivedAt: null, startedAt: null, completedAt: null }]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "has_progress" });
  });
});
