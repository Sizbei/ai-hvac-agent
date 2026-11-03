import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Pure test: @/lib/db is mocked. Each db.select(...) chain resolves to the
// next queued row set; db.execute records the raw SQL it was given.
const { selectQueue, executed, updates, batch, timeOff } = vi.hoisted(() => ({
  selectQueue: [] as unknown[][],
  updates: [] as { set: unknown; where: unknown }[],
  executed: [] as unknown[],
  batch: vi.fn(),
  timeOff: vi.fn(),
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
  return {
    db: {
      select: () => chain(),
      execute: (q: unknown) => {
        executed.push(q);
        return { kind: "execute" };
      },
      update: () => ({
        set: (set: unknown) => ({
          where: (where: unknown) => {
            updates.push({ set, where });
            return { returning: () => ({ kind: "update" }), kind: "update" };
          },
        }),
      }),
      delete: () => ({ where: () => ({ kind: "delete" }) }),
      batch,
    },
  };
});

vi.mock("./shift-queries", () => ({ technicianTimeOffOverlapping: timeOff }));

import { addAppointment, cancelAppointment, updateAppointment } from "./appointment-queries";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const T1 = "33333333-3333-4333-8333-333333333333";
const T2 = "44444444-4444-4444-8444-444444444444";
const input = {
  arrivalWindowStart: "2026-11-05T13:00:00.000Z",
  arrivalWindowEnd: "2026-11-05T17:00:00.000Z",
  technicianIds: [T1, T2],
};
const PTO = [{ id: "s1", technicianId: T2, kind: "time_off", title: null, startsAt: "", endsAt: "", removesCapacity: true }];

beforeEach(() => {
  selectQueue.length = 0;
  executed.length = 0;
  updates.length = 0;
  batch.mockReset();
  timeOff.mockReset();
});

describe("addAppointment — time off", () => {
  it("refuses with time_off before writing when any technician is off", async () => {
    selectQueue.push([{ status: "new" }], [{ id: T1 }, { id: T2 }]);
    timeOff.mockImplementation(async (_o: string, id: string) => (id === T2 ? PTO : []));
    expect(await addAppointment(ORG, REQ, input, T1)).toEqual({ reason: "time_off" });
    expect(timeOff).toHaveBeenCalledWith(ORG, T2, new Date(input.arrivalWindowStart), new Date(input.arrivalWindowEnd));
    expect(batch).not.toHaveBeenCalled();
  });

  it("guards the insert atomically and reports time off that landed after the pre-check", async () => {
    selectQueue.push([{ status: "new" }], [{ id: T1 }, { id: T2 }], []);
    timeOff.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValue(PTO);
    batch.mockResolvedValue([{ rows: [] }, {}]);
    expect(await addAppointment(ORG, REQ, input, T1)).toEqual({ reason: "time_off" });
    const { sql, params } = new PgDialect().sqlToQuery(executed[0] as SQL);
    expect(sql).toMatch(/NOT EXISTS \(SELECT 1 FROM technician_shifts s/);
    expect(sql).toMatch(/s\.technician_id = ANY\(\$\d+::uuid\[\]\)/);
    // The ids travel as ONE array parameter, never expanded.
    expect(params).toContainEqual([T1, T2]);
    // The visit date is written with the window.
    expect(sql).toMatch(/scheduled_date, starts_at/);
  });
});

describe("updateAppointment — time off", () => {
  it("refuses with time_off before writing", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]);
    timeOff.mockResolvedValue(PTO);
    const r = await updateAppointment(ORG, REQ, "55555555-5555-4555-8555-555555555555", { ...input, version: 0 }, T1);
    expect(r).toEqual({ reason: "time_off" });
    expect(batch).not.toHaveBeenCalled();
  });
});

const AID = "55555555-5555-4555-8555-555555555555";
const render = (q: unknown) => new PgDialect().sqlToQuery(q as SQL);

describe("updateAppointment — progress lock", () => {
  it("puts the progress predicate in the CAS", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]);
    timeOff.mockResolvedValue([]);
    batch.mockResolvedValue([[], {}, {}]);
    selectQueue.push([{ n: 2, cancelledAt: null, version: 0 }], [{ status: "scheduled" }], [{ id: "a1" }]);
    await updateAppointment(ORG, REQ, AID, { ...input, version: 0 }, T1);
    const { sql } = render(updates[0].where);
    expect(sql).toMatch(/not EXISTS \(SELECT 1 FROM appointment_assignments a WHERE a\.appointment_id = .*\(a\.en_route_at IS NOT NULL OR a\.arrived_at IS NOT NULL OR a\.started_at IS NOT NULL OR a\.completed_at IS NOT NULL\)/i);
  });

  it("reports has_progress when the CAS misses on a current version with a progressed row", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]);
    timeOff.mockResolvedValue([]);
    batch.mockResolvedValue([[], {}, {}]);
    selectQueue.push([{ n: 2, cancelledAt: null, version: 0 }], [{ status: "scheduled" }], [{ id: "a1" }]);
    expect(await updateAppointment(ORG, REQ, AID, { ...input, version: 0 }, T1)).toEqual({ reason: "has_progress" });
  });

  it("reports version_conflict for a stale version even when progress exists", async () => {
    selectQueue.push([{ id: T1 }, { id: T2 }]);
    timeOff.mockResolvedValue([]);
    batch.mockResolvedValue([[], {}, {}]);
    selectQueue.push([{ n: 2, cancelledAt: null, version: 3 }], [{ status: "scheduled" }], [{ id: "a1" }]);
    expect(await updateAppointment(ORG, REQ, AID, { ...input, version: 0 }, T1)).toEqual({ reason: "version_conflict" });
  });
});

describe("addAppointment — completed request", () => {
  it("refuses a completed request before writing", async () => {
    selectQueue.push([{ status: "completed" }]);
    expect(await addAppointment(ORG, REQ, input, T1)).toEqual({ reason: "request_completed" });
    expect(batch).not.toHaveBeenCalled();
  });
});

describe("cancelAppointment — job time and finished rows", () => {
  it("closes the visit technicians' job entries gated on the appointment write, and spares finished rows", async () => {
    selectQueue.push([{ technicianId: T1 }, { technicianId: T2 }]);
    batch.mockResolvedValue([[{ id: AID, appointmentNumber: 2 }], {}, {}]);
    expect(await cancelAppointment(ORG, REQ, AID, 0)).toEqual({ ok: true, appointmentNumber: 2 });
    const assignUpdate = render(updates[1].where).sql;
    expect(assignUpdate).toMatch(/"status" NOT IN \('completed'::request_status, 'cancelled'::request_status\)/);
    const close = render(executed[0]);
    expect(close.sql).toMatch(/UPDATE technician_time_entries t SET clock_out_at = now\(\)/);
    expect(close.sql).toMatch(/t\.technician_id = ANY\(\$\d+::uuid\[\]\)/);
    expect(close.sql).toMatch(/AND \(EXISTS \(SELECT 1 FROM "appointments" p WHERE .*p\.xmin = pg_current_xact_id\(\)::xid\)\)/);
    expect(close.params).toContainEqual([T1, T2]);
  });
});
