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

  it("checks time off over the visit window; date-only visits use the business day", async () => {
    m.getAppointment.mockResolvedValueOnce(visit({ startsAt: null, endsAt: null, scheduledDate: "2026-11-02T15:00:00.000Z" }));
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    m.getAppointment.mockResolvedValueOnce(visit());
    await addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    const [, , start, end] = m.noTimeOff.mock.calls[0];
    expect(start).toBe("2026-11-02T05:00:00.000Z"); // business midnight (EST after Nov 1 fall-back)
    expect(end).toBe("2026-11-03T05:00:00.000Z");
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
    it("time_off", async () => {
      m.anyTimeOff.mockResolvedValueOnce(true);
      expect(await miss({})).toEqual({ reason: "time_off" });
    });
  });
});

describe("removeVisitTechnician", () => {
  it("deletes a helper with no progress", async () => {
    m.execute.mockResolvedValueOnce({ rows: [{ id: "a" }] });
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ ok: true });
    const text = new PgDialect().sqlToQuery(m.executed[0] as SQL).sql;
    expect(text).toContain("NOT a.is_lead");
    expect(text).toContain("a.started_at IS NULL");
  });
  it("not_found when the technician has no row on the visit", async () => {
    m.execute.mockResolvedValueOnce({ rows: [] });
    m.selectQueue.push([]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "not_found" });
  });
  it("is_lead", async () => {
    m.execute.mockResolvedValueOnce({ rows: [] });
    m.selectQueue.push([{ isLead: true, enRouteAt: null, arrivedAt: null, startedAt: null, completedAt: null }]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "is_lead" });
  });
  it("has_progress", async () => {
    m.execute.mockResolvedValueOnce({ rows: [] });
    m.selectQueue.push([{ isLead: false, enRouteAt: new Date(), arrivedAt: null, startedAt: null, completedAt: null }]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "has_progress" });
  });
});
