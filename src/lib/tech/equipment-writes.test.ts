import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, batch } = vi.hoisted(() => ({ readQueue: [] as unknown[][], batch: vi.fn() }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => ({
      __sql: q,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve({ rows: readQueue.shift() ?? [] }).then(ok, err),
    }),
    batch,
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));

import { addFieldEquipment, locationRuleSql, onJobSql, replaceOutcome } from "./equipment-writes";
import type { EquipmentInput } from "./equipment-input";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const NEW = "44444444-4444-4444-8444-444444444444";
const OLD = "55555555-5555-4555-8555-555555555555";
const CUST = "66666666-6666-4666-8666-666666666666";
const actor = { organizationId: ORG, requestId: REQ, techUserId: ME };
const input = (over: Partial<EquipmentInput> = {}): EquipmentInput => ({
  equipmentType: "ac", make: "Carrier", model: null, serialNumber: null, locationInHome: null, notes: null,
  installDate: "2026-11-06", replacesId: null, ...over,
});

const dialect = new PgDialect();
const renderQ = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL);
const render = (q: unknown) => renderQ(q).sql.replace(/\s+/g, " ").trim();
const stmts = () => (batch.mock.calls[0]![0] as unknown[]).map(render);
const rowsOf = (...r: unknown[][]) => r.map((rows) => ({ rows }));

beforeEach(() => { readQueue.length = 0; batch.mockReset(); });

describe("SQL pieces", () => {
  it("location rule: request without a location → any unit; else same location or none (parenthesised OR)", () => {
    expect(render(locationRuleSql("ce", "r"))).toBe("(r.location_id IS NULL OR ce.location_id IS NULL OR ce.location_id = r.location_id)");
  });
  it("on the job: a non-cancelled assignment on a non-cancelled visit, org-bound twice", () => {
    const q = renderQ(onJobSql(ORG, REQ, ME));
    expect(q.sql).toContain("p.cancelled_at IS NULL");
    expect(q.sql).toContain("a.status <> 'cancelled'::request_status");
    expect(q.params.filter((p) => p === ORG)).toHaveLength(2);
  });
});

describe("addFieldEquipment (spec §5.6)", () => {
  it("no customer on the request → no_customer, nothing written", async () => {
    readQueue.push([{ customer_id: null }]);
    expect(await addFieldEquipment(actor, { equipmentId: NEW }, input())).toEqual({ ok: false, reason: "no_customer" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("add: INSERT … FROM service_requests with the request's location, noon Eastern install date, ON CONFLICT DO NOTHING", async () => {
    readQueue.push([{ customer_id: CUST }]);
    batch.mockResolvedValueOnce(rowsOf([], [{ id: NEW }], []));
    expect(await addFieldEquipment(actor, { equipmentId: NEW }, input())).toEqual({ ok: true, equipmentId: NEW, created: true, replaced: false });
    const s = stmts();
    expect(s[1]).toMatch(/^INSERT INTO customer_equipment \(id, organization_id, customer_id, location_id, equipment_type, make, model, serial_number, location_in_home, notes, install_date\)/);
    expect(s[1]).toContain("r.location_id, $4::equipment_type");
    expect(s[1]).toContain("r.customer_id = $");
    expect(s[1]).toContain("r.status IN ('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status, 'completed'::request_status)");
    expect(s[1]).toContain("ON CONFLICT (id) DO NOTHING RETURNING id");
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[1]).params).toContain("2026-11-06T17:00:00.000Z");
  });

  it("add replay: the row exists → created:false", async () => {
    readQueue.push([{ customer_id: CUST }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [{ exists: true }]));
    expect(await addFieldEquipment(actor, { equipmentId: NEW }, input())).toEqual({ ok: true, equipmentId: NEW, created: false, replaced: false });
  });

  it("replace: lock the old row, insert only while it is live, retire it only when this transaction wrote the new row", async () => {
    readQueue.push([{ customer_id: CUST }]);
    batch.mockResolvedValueOnce(rowsOf([], [{ "?column?": 1 }], [{ id: NEW }], [{ id: OLD }], []));
    expect(await addFieldEquipment(actor, { equipmentId: NEW }, input({ replacesId: OLD })))
      .toEqual({ ok: true, equipmentId: NEW, created: true, replaced: true });
    const s = stmts();
    expect(s).toHaveLength(5);
    expect(s[1]).toContain("FOR NO KEY UPDATE OF ce");
    expect(s[1]).toContain("ce.fieldpulse_asset_id IS NULL AND r.customer_id = $");
    expect(s[1]).toContain("a.status <> 'cancelled'::request_status");
    expect(s[1]).toContain("(r.location_id IS NULL OR ce.location_id IS NULL OR ce.location_id = r.location_id)");
    expect(s[2]).toContain("AND EXISTS (SELECT 1 FROM customer_equipment ce WHERE ce.id = $");
    expect(s[2]).toContain("ce.retired_at IS NULL AND ce.fieldpulse_asset_id IS NULL");
    expect(s[3]).toContain("SET retired_at = now(), replaced_by_equipment_id = $1::uuid, updated_at = now()");
    expect(s[3]).toContain("n.xmin = pg_current_xact_id()::xid");
    for (const st of s.slice(1, 5)) expect(st).toContain("ce.customer_id = $");
  });

  it("replace zero rows map through replaceOutcome", async () => {
    readQueue.push([{ customer_id: CUST }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [], [{ retired: true, replaced_by_equipment_id: "77777777-7777-4777-8777-777777777777", synced: false }]));
    expect(await addFieldEquipment(actor, { equipmentId: NEW }, input({ replacesId: OLD }))).toEqual({ ok: false, reason: "equipment_retired" });
  });
});

describe("replaceOutcome", () => {
  it("replay first, then retired, then FieldPulse; an invisible unit is not found; a visible live one that was not written is stale", () => {
    expect(replaceOutcome({ retired: true, replaced_by_equipment_id: NEW, synced: false }, NEW)).toEqual({ ok: true, equipmentId: NEW, created: false, replaced: true });
    expect(replaceOutcome({ retired: true, replaced_by_equipment_id: OLD, synced: false }, NEW)).toEqual({ ok: false, reason: "equipment_retired" });
    expect(replaceOutcome({ retired: false, replaced_by_equipment_id: null, synced: true }, NEW)).toEqual({ ok: false, reason: "managed_externally" });
    expect(replaceOutcome({ retired: false, replaced_by_equipment_id: null, synced: false }, NEW)).toEqual({ ok: false, reason: "stale" });
    expect(replaceOutcome(undefined, NEW)).toEqual({ ok: false, reason: "not_found" });
  });
});
