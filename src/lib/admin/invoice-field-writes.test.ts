import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Pure test: @/lib/db is mocked. db.execute returns a thenable that carries its
// SQL (so db.batch can capture it) and, when awaited directly (a pre-read or a
// post-batch read), resolves the next scripted `{ rows }` from readQueue.
const { readQueue, reads, batch, getDefaultTaxBps, getPricebookItemById } = vi.hoisted(() => ({
  readQueue: [] as unknown[][],
  reads: [] as unknown[],
  batch: vi.fn(),
  getDefaultTaxBps: vi.fn(),
  getPricebookItemById: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => ({
      __sql: q,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => {
        reads.push(q);
        return Promise.resolve({ rows: readQueue.shift() ?? [] }).then(ok, err);
      },
    }),
    batch,
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps, getPricebookItemById }));

import {
  addInvoiceLine,
  createInvoiceFromJob,
  finalizeInvoice,
  lockInvoiceSql,
  lockRequestSql,
  P_LIVE,
  P_NATIVE,
  removeInvoiceLine,
  stillLeadSql,
  totalsSql,
} from "./invoice-field-writes";
import { materialLineId } from "@/lib/http/idempotency";
import { sql } from "drizzle-orm";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const INV = "44444444-4444-4444-8444-444444444444";
const LINE = "55555555-5555-4555-8555-555555555555";
const MAT1 = "66666666-6666-4666-8666-666666666666";
const MAT2 = "77777777-7777-4777-8777-777777777777";
const ITEM = "88888888-8888-4888-8888-888888888888";
const OTHER = "99999999-9999-4999-8999-999999999999";
const CUST = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const dialect = new PgDialect();
const renderQ = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL);
const render = (q: unknown): string => renderQ(q).sql.replace(/\s+/g, " ").trim();
const stmts = (): string[] => (batch.mock.calls[0]![0] as unknown[]).map(render);
const params = (): number[] => (batch.mock.calls[0]![0] as unknown[]).map((q) => renderQ(q).params.length);
const res = (...rowSets: unknown[][]) => rowSets.map((rows) => ({ rows }));

const TECH = { organizationId: ORG, requestId: REQ, techUserId: ME };
const OFFICE = { organizationId: ORG, requestId: null, techUserId: null };
const LOCK_REQ = /^SELECT 1 FROM service_requests WHERE id = \$1::uuid AND organization_id = \$2::uuid FOR NO KEY UPDATE$/;
const LOCK_INV = /^SELECT 1 FROM invoices WHERE id = \$1::uuid AND organization_id = \$2::uuid FOR NO KEY UPDATE$/;
const XMIN = "xmin = pg_current_xact_id()::xid";
const SIG_CASE = "CASE WHEN r.signed_at >= invoices.updated_at";
const T_KEEPS_UPDATED_AT = "updated_at = CASE WHEN invoices.subtotal_cents <> s.sub OR invoices.total_cents <> s.sub + s.tax THEN now() ELSE invoices.updated_at END";

beforeEach(() => {
  readQueue.length = 0;
  reads.length = 0;
  batch.mockReset();
  getDefaultTaxBps.mockReset().mockResolvedValue(925);
  getPricebookItemById.mockReset();
});

describe("shared SQL builders", () => {
  it("P_LIVE is parenthesised (it holds an OR) and casts every enum literal", () => {
    expect(render(P_LIVE)).toBe("(state = 'draft'::invoice_state OR state = 'open'::invoice_state)");
    expect(render(P_NATIVE)).toBe("fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL");
  });

  it("locks, the lead check and T carry org on every table reference", () => {
    expect(render(lockRequestSql(ORG, REQ))).toMatch(LOCK_REQ);
    expect(render(lockInvoiceSql(ORG, INV))).toMatch(LOCK_INV);
    const lead = renderQ(stillLeadSql(ORG, REQ, ME));
    expect(lead.params).toHaveLength(4);
    expect(lead.sql).toContain("p.organization_id = $2::uuid AND a.organization_id = $3::uuid");
    expect(lead.sql).toContain("a.is_lead AND a.status IN ('");
    expect(lead.sql).toContain("'completed'::request_status)");
    expect(lead.sql).toContain("p.cancelled_at IS NULL");
    const t = renderQ(totalsSql(ORG, INV, 925, sql.raw("TRUE")));
    expect(t.params).toHaveLength(5);
    expect(t.params[0]).toBe(925); // the tax rate is bound once
    expect(t.sql).toContain("ROUND(t.sub * $1::int / 10000.0)::int AS tax");
    expect(t.sql).toContain("tax_cents = s.tax");
    expect(t.sql).toContain("total_cents = s.sub + s.tax");
    expect(t.sql.replace(/\s+/g, " ")).toContain(T_KEEPS_UPDATED_AT);
    expect(t.sql).toMatch(/FROM invoice_line_items WHERE invoice_id = \$\d::uuid AND organization_id = \$\d::uuid\) t\) s/);
  });

  it("T bumps updated_at on a subtotal change OR a total change (a tax-rate change moves only the total)", () => {
    const t = render(totalsSql(ORG, INV, 925, sql.raw("TRUE")));
    const caseExpr = t.slice(t.indexOf("updated_at = CASE"), t.indexOf(" END", t.indexOf("updated_at = CASE")));
    expect(caseExpr).toContain("invoices.subtotal_cents <> s.sub");
    expect(caseExpr).toContain("invoices.total_cents <> s.sub + s.tax");
    expect(caseExpr).toContain(" OR ");
  });
});

describe("createInvoiceFromJob", () => {
  const actor = { ...TECH, requestId: REQ, techUserId: ME };
  const nativeReq = [{ customer_id: CUST, native: true, external_invoice: false }];
  const mats = [
    { id: MAT1, name: "Capacitor", quantity: 2, unit_price_cents: 1500, unit_cost_cents: 600 },
    { id: MAT2, name: "Material", quantity: 1, unit_price_cents: 900, unit_cost_cents: 0 },
  ];

  it("created: lock, guarded insert, xmin-seeded lines, T(xmin), live select, still_lead", async () => {
    readQueue.push(nativeReq, mats);
    batch.mockResolvedValue(res([], [{ id: INV }], [], [], [{ id: INV, state: "draft" }], [{ still_lead: true }]));
    const out = await createInvoiceFromJob(actor, { invoiceId: INV });
    expect(out).toEqual({ ok: true, invoiceId: INV, state: "draft", created: true });

    // pre-reads: the request (native + external invoice) and the unbilled materials
    const r0 = render(reads[0]);
    expect(r0).toContain("(i.fieldpulse_invoice_id IS NOT NULL OR i.hcp_invoice_id IS NOT NULL)");
    const r1 = render(reads[1]);
    expect(r1).toContain("COALESCE(pi.name, m.description, 'Material')");
    expect(r1).toContain("pi.organization_id = $");
    expect(r1).toContain("NOT EXISTS (SELECT 1 FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id WHERE l.job_material_id = m.id");
    expect(r1).toContain("i.state <> 'void'::invoice_state");

    const s = stmts();
    expect(s).toHaveLength(6);
    expect(params()).toEqual([2, 10, 21, 5, 2, 4]);
    expect(s[0]).toMatch(LOCK_REQ);
    expect(s[1]).toMatch(/^INSERT INTO invoices \(id, organization_id, service_request_id, customer_id, state, subtotal_cents, tax_cents, total_cents, amount_paid_cents\)/);
    expect(s[1]).toContain("'draft'::invoice_state, 0, 0, 0, 0 WHERE (EXISTS (SELECT 1 FROM appointment_assignments a");
    expect(s[1]).toContain("AND NOT EXISTS (SELECT 1 FROM invoices WHERE organization_id = $");
    expect(s[1]).toContain("AND (state = 'draft'::invoice_state OR state = 'open'::invoice_state) AND fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL)");
    expect(s[1]).toMatch(/ON CONFLICT DO NOTHING RETURNING id$/);
    expect(s[2]).toMatch(/^INSERT INTO invoice_line_items \(id, organization_id, invoice_id, job_material_id, name, quantity, unit_price_cents, cost_cents, line_total_cents\)/);
    expect(s[2]).toContain(`EXISTS (SELECT 1 FROM invoices WHERE id = $`);
    expect(s[2]).toContain(XMIN);
    expect(s[2]).toMatch(/ON CONFLICT \(id\) DO NOTHING$/);
    expect(s[3]).toMatch(/^UPDATE invoices SET subtotal_cents = s\.sub/);
    expect(s[3]).toContain(`invoices.${XMIN}`);
    expect(s[4]).toMatch(/ORDER BY created_at DESC LIMIT 1$/);
    expect(s[4]).toContain("(state = 'draft'::invoice_state OR state = 'open'::invoice_state)");
    expect(s[5]).toMatch(/^SELECT \(EXISTS .*\) AS still_lead$/);

    // seeded line ids are invoice-scoped and the totals are quantity * unit price
    const seedParams = renderQ((batch.mock.calls[0]![0] as unknown[])[2]).params;
    expect(seedParams).toContain(materialLineId(INV, MAT1));
    expect(seedParams).toContain(MAT1);
    expect(seedParams).toContain(3000);
    expect(getDefaultTaxBps).toHaveBeenCalledWith(ORG);
  });

  it("no unbilled materials: no seed statement", async () => {
    readQueue.push(nativeReq, []);
    batch.mockResolvedValue(res([], [{ id: INV }], [], [{ id: INV, state: "draft" }], [{ still_lead: true }]));
    await createInvoiceFromJob(actor, { invoiceId: INV });
    expect(params()).toEqual([2, 10, 5, 2, 4]);
    expect(stmts().some((q) => q.startsWith("INSERT INTO invoice_line_items"))).toBe(false);
  });

  it("adopted: the live invoice comes from the final SELECT", async () => {
    readQueue.push(nativeReq, []);
    batch.mockResolvedValue(res([], [], [], [{ id: OTHER, state: "open" }], [{ still_lead: true }]));
    expect(await createInvoiceFromJob(actor, { invoiceId: INV })).toEqual({ ok: true, invoiceId: OTHER, state: "open", created: false });
  });

  it("history: no live invoice and this key's invoice is paid", async () => {
    readQueue.push(nativeReq, [], [{ state: "paid" }]);
    batch.mockResolvedValue(res([], [], [], [], [{ still_lead: true }]));
    expect(await createInvoiceFromJob(actor, { invoiceId: INV })).toEqual({ ok: true, invoiceId: INV, state: "paid", created: false });
    expect(render(reads[2])).toMatch(/^SELECT state FROM invoices WHERE id = \$1::uuid AND organization_id = \$2::uuid$/);
  });

  it("voided: this key's invoice was voided", async () => {
    readQueue.push(nativeReq, [], [{ state: "void" }]);
    batch.mockResolvedValue(res([], [], [], [], [{ still_lead: true }]));
    expect(await createInvoiceFromJob(actor, { invoiceId: INV })).toEqual({ ok: false, reason: "invoice_voided" });
  });

  it("not_lead wins over adopt", async () => {
    readQueue.push(nativeReq, []);
    batch.mockResolvedValue(res([], [], [], [{ id: OTHER, state: "draft" }], [{ still_lead: false }]));
    expect(await createInvoiceFromJob(actor, { invoiceId: INV })).toEqual({ ok: false, reason: "not_lead" });
  });

  it("refuses non-native requests and FieldPulse invoices before any write", async () => {
    readQueue.push([{ customer_id: null, native: false, external_invoice: false }]);
    expect(await createInvoiceFromJob(actor, { invoiceId: INV })).toEqual({ ok: false, reason: "managed_externally" });
    readQueue.push([{ customer_id: null, native: true, external_invoice: true }]);
    expect(await createInvoiceFromJob(actor, { invoiceId: INV })).toEqual({ ok: false, reason: "external_invoice" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("a deadlock maps to stale", async () => {
    readQueue.push(nativeReq, []);
    batch.mockRejectedValue(Object.assign(new Error("q"), { cause: { code: "40P01" } }));
    expect(await createInvoiceFromJob(actor, { invoiceId: INV })).toEqual({ ok: false, reason: "stale" });
  });
});

describe("addInvoiceLine", () => {
  const item = { id: ITEM, name: "Diagnostic", priceCents: 8900, costCents: 0, active: true, type: "service" };

  it("pricebook line inserted: lock order, draft EXISTS, T with amount_paid_cents = 0", async () => {
    getPricebookItemById.mockResolvedValue(item);
    batch.mockResolvedValue(res([], [], [{ id: LINE }], [], [{ state: "draft", line_exists: true, already_billed: false }], [{ still_lead: true }]));
    const out = await addInvoiceLine(TECH, INV, { lineId: LINE }, { pricebookItemId: ITEM, quantity: 2 });
    expect(out).toEqual({ ok: true, lineId: LINE });
    const s = stmts();
    expect(params()).toEqual([2, 2, 16, 5, 6, 4]);
    expect(s[0]).toMatch(LOCK_REQ);
    expect(s[1]).toMatch(LOCK_INV);
    expect(s[2]).toMatch(/^INSERT INTO invoice_line_items/);
    expect(s[2]).toContain("WHERE (EXISTS (SELECT 1 FROM appointment_assignments a");
    expect(s[2]).toContain("i.service_request_id = $");
    expect(s[2]).toContain("i.state = 'draft'::invoice_state AND fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL");
    expect(s[2]).toMatch(/ON CONFLICT \(id\) DO NOTHING RETURNING id$/);
    expect(s[3]).toContain("invoices.state = 'draft'::invoice_state AND invoices.amount_paid_cents = 0");
    expect(s[3]).toContain(T_KEEPS_UPDATED_AT);
    expect(s[4]).toMatch(/^SELECT state, EXISTS/);
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[2]).params).toContain(17800);
  });

  it("material line: invoice-scoped id, job_material_id and the not-billed guard", async () => {
    readQueue.push([{ id: MAT1, name: "Capacitor", quantity: 1, unit_price_cents: 1500, unit_cost_cents: 600 }]);
    const lid = materialLineId(INV, MAT1);
    batch.mockResolvedValue(res([], [], [{ id: lid }], [], [{ state: "draft", line_exists: true, already_billed: true }], [{ still_lead: true }]));
    expect(await addInvoiceLine(TECH, INV, { lineId: LINE }, { jobMaterialId: MAT1 })).toEqual({ ok: true, lineId: lid });
    expect(render(reads[0])).toContain("m.service_request_id = $");
    expect(params()).toEqual([2, 2, 20, 5, 10, 4]);
    const s = stmts();
    expect(s[2]).toContain("AND NOT EXISTS (SELECT 1 FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id WHERE l.job_material_id = $");
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[2]).params).toContain(lid);
  });

  it("replayed: not inserted and the line already exists", async () => {
    getPricebookItemById.mockResolvedValue(item);
    batch.mockResolvedValue(res([], [], [], [], [{ state: "draft", line_exists: true, already_billed: false }], [{ still_lead: true }]));
    expect(await addInvoiceLine(TECH, INV, { lineId: LINE }, { pricebookItemId: ITEM, quantity: 1 })).toEqual({ ok: true, lineId: LINE, replayed: true });
  });

  it("already_billed: draft intact, material linked elsewhere", async () => {
    readQueue.push([{ id: MAT1, name: "Capacitor", quantity: 1, unit_price_cents: 1500, unit_cost_cents: 600 }]);
    batch.mockResolvedValue(res([], [], [], [], [{ state: "draft", line_exists: false, already_billed: true }], [{ still_lead: true }]));
    expect(await addInvoiceLine(TECH, INV, { lineId: LINE }, { jobMaterialId: MAT1 })).toEqual({ ok: false, reason: "already_billed" });
  });

  it("locked / not found / not lead / item not found", async () => {
    getPricebookItemById.mockResolvedValue(item);
    batch.mockResolvedValueOnce(res([], [], [], [], [{ state: "open", line_exists: false, already_billed: false }], [{ still_lead: true }]));
    expect(await addInvoiceLine(TECH, INV, { lineId: LINE }, { pricebookItemId: ITEM, quantity: 1 })).toEqual({ ok: false, reason: "invoice_locked" });
    batch.mockResolvedValueOnce(res([], [], [], [], [], [{ still_lead: true }]));
    expect(await addInvoiceLine(TECH, INV, { lineId: LINE }, { pricebookItemId: ITEM, quantity: 1 })).toEqual({ ok: false, reason: "invoice_not_found" });
    batch.mockResolvedValueOnce(res([], [], [], [], [{ state: "draft", line_exists: false, already_billed: false }], [{ still_lead: false }]));
    expect(await addInvoiceLine(TECH, INV, { lineId: LINE }, { pricebookItemId: ITEM, quantity: 1 })).toEqual({ ok: false, reason: "not_lead" });
    getPricebookItemById.mockResolvedValue({ ...item, active: false });
    expect(await addInvoiceLine(TECH, INV, { lineId: LINE }, { pricebookItemId: ITEM, quantity: 1 })).toEqual({ ok: false, reason: "item_not_found" });
    readQueue.push([]);
    expect(await addInvoiceLine(TECH, INV, { lineId: LINE }, { jobMaterialId: MAT1 })).toEqual({ ok: false, reason: "item_not_found" });
  });

  it("office path: invoice pre-read, TRUE for lead and request predicates, synced refused", async () => {
    getPricebookItemById.mockResolvedValue(item);
    readQueue.push([{ service_request_id: REQ, synced: false }]);
    batch.mockResolvedValue(res([], [], [{ id: LINE }], [], [{ state: "draft", line_exists: true, already_billed: false }]));
    expect(await addInvoiceLine(OFFICE, INV, { lineId: LINE }, { pricebookItemId: ITEM, quantity: 1 })).toEqual({ ok: true, lineId: LINE });
    expect(params()).toEqual([2, 2, 11, 5, 5]);
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[0]).params[0]).toBe(REQ);
    const s = stmts();
    expect(s[2]).toContain("WHERE (TRUE) AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = $");
    expect(s[2]).toContain("AND TRUE AND i.state = 'draft'::invoice_state");
    expect(s.some((q) => q.includes("still_lead"))).toBe(false);

    readQueue.push([{ service_request_id: REQ, synced: true }]);
    expect(await addInvoiceLine(OFFICE, INV, { lineId: LINE }, { pricebookItemId: ITEM, quantity: 1 })).toEqual({ ok: false, reason: "synced_read_only" });
    readQueue.push([]);
    expect(await addInvoiceLine(OFFICE, INV, { lineId: LINE }, { pricebookItemId: ITEM, quantity: 1 })).toEqual({ ok: false, reason: "invoice_not_found" });
  });
});

describe("removeInvoiceLine", () => {
  it("removes under the draft + unpaid gate, T with amount_paid_cents = 0", async () => {
    batch.mockResolvedValue(res([], [], [{ id: LINE }], [], [{ state: "draft" }], [{ still_lead: true }]));
    expect(await removeInvoiceLine(TECH, INV, LINE)).toEqual({ ok: true, removed: true });
    expect(params()).toEqual([2, 2, 10, 5, 3, 4]);
    const s = stmts();
    expect(s[0]).toMatch(LOCK_REQ);
    expect(s[1]).toMatch(LOCK_INV);
    expect(s[2]).toMatch(/^DELETE FROM invoice_line_items WHERE id = \$1::uuid AND invoice_id = \$2::uuid AND organization_id = \$3::uuid AND \(EXISTS/);
    expect(s[2]).toContain("i.state = 'draft'::invoice_state AND fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL AND i.amount_paid_cents = 0) RETURNING id");
    expect(s[3]).toContain("invoices.amount_paid_cents = 0");
    expect(s[3]).toContain(T_KEEPS_UPDATED_AT);
    expect(s[4]).toMatch(/^SELECT state, amount_paid_cents FROM invoices/);
  });

  it("already gone, locked, not found, not lead", async () => {
    batch.mockResolvedValueOnce(res([], [], [], [], [{ state: "draft", amount_paid_cents: 0 }], [{ still_lead: true }]));
    expect(await removeInvoiceLine(TECH, INV, LINE)).toEqual({ ok: true, removed: false });
    batch.mockResolvedValueOnce(res([], [], [], [], [{ state: "open" }], [{ still_lead: true }]));
    expect(await removeInvoiceLine(TECH, INV, LINE)).toEqual({ ok: false, reason: "invoice_locked" });
    batch.mockResolvedValueOnce(res([], [], [], [], [{ state: "draft", amount_paid_cents: 500 }], [{ still_lead: true }]));
    expect(await removeInvoiceLine(TECH, INV, LINE)).toEqual({ ok: false, reason: "invoice_locked" });
    batch.mockResolvedValueOnce(res([], [], [], [], [], [{ still_lead: true }]));
    expect(await removeInvoiceLine(TECH, INV, LINE)).toEqual({ ok: false, reason: "invoice_not_found" });
    batch.mockResolvedValueOnce(res([], [], [], [], [{ state: "draft" }], [{ still_lead: false }]));
    expect(await removeInvoiceLine(TECH, INV, LINE)).toEqual({ ok: false, reason: "not_lead" });
  });
});

describe("finalizeInvoice", () => {
  it("tech: CAS draft → open with the fresh-signature snapshot", async () => {
    batch.mockResolvedValue(res([], [], [{ state: "open" }], [{ state: "open", lines: "2" }], [{ still_lead: true }]));
    expect(await finalizeInvoice(TECH, INV)).toEqual({ ok: true, state: "open", changed: true });
    expect(params()).toEqual([2, 2, 10, 5, 4]);
    const s = stmts();
    expect(s[0]).toMatch(LOCK_REQ);
    expect(s[1]).toMatch(LOCK_INV);
    expect(s[2]).toMatch(/^UPDATE invoices SET state = 'open'::invoice_state, issued_at = now\(\)/);
    expect(s[2].split(SIG_CASE)).toHaveLength(4);
    expect(s[2]).toContain("THEN r.signature_url END");
    expect(s[2]).toContain("THEN r.signature_name END");
    expect(s[2]).toContain("THEN r.signed_at END");
    expect(s[2]).toContain("FROM service_requests r WHERE r.id = invoices.service_request_id AND r.organization_id = $");
    expect(s[2]).toContain("invoices.state = 'draft'::invoice_state AND invoices.fieldpulse_invoice_id IS NULL AND invoices.hcp_invoice_id IS NULL");
    expect(s[2]).toContain("AND (EXISTS (SELECT 1 FROM appointment_assignments a");
    expect(s[2]).toMatch(/EXISTS \(SELECT 1 FROM invoice_line_items WHERE invoice_id = \$\d+::uuid AND organization_id = \$\d+::uuid\) RETURNING invoices\.state$/);
    expect(s[3]).toContain("(SELECT COUNT(*) FROM invoice_line_items WHERE invoice_id = $");
  });

  it("replay, no_lines, voided, not found, not lead", async () => {
    batch.mockResolvedValueOnce(res([], [], [], [{ state: "paid", lines: "1" }], [{ still_lead: true }]));
    expect(await finalizeInvoice(TECH, INV)).toEqual({ ok: true, state: "paid", changed: false });
    batch.mockResolvedValueOnce(res([], [], [], [{ state: "draft", lines: "0" }], [{ still_lead: true }]));
    expect(await finalizeInvoice(TECH, INV)).toEqual({ ok: false, reason: "no_lines" });
    batch.mockResolvedValueOnce(res([], [], [], [{ state: "void", lines: "1" }], [{ still_lead: true }]));
    expect(await finalizeInvoice(TECH, INV)).toEqual({ ok: false, reason: "invoice_locked" });
    batch.mockResolvedValueOnce(res([], [], [], [], [{ still_lead: true }]));
    expect(await finalizeInvoice(TECH, INV)).toEqual({ ok: false, reason: "invoice_not_found" });
    batch.mockResolvedValueOnce(res([], [], [], [{ state: "draft", lines: "1" }], [{ still_lead: false }]));
    expect(await finalizeInvoice(TECH, INV)).toEqual({ ok: false, reason: "not_lead" });
    batch.mockRejectedValueOnce(Object.assign(new Error("q"), { cause: { code: "40P01" } }));
    expect(await finalizeInvoice(TECH, INV)).toEqual({ ok: false, reason: "stale" });
  });

  it("office with a request: L_req, TRUE for the lead check, no still_lead", async () => {
    readQueue.push([{ service_request_id: REQ, synced: false }]);
    batch.mockResolvedValue(res([], [], [{ state: "open" }], [{ state: "open", lines: "1" }]));
    expect(await finalizeInvoice(OFFICE, INV)).toEqual({ ok: true, state: "open", changed: true });
    expect(params()).toEqual([2, 2, 5, 4]);
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[0]).params[0]).toBe(REQ);
    const s = stmts();
    expect(s[0]).toMatch(LOCK_REQ);
    expect(s[2]).toContain("AND TRUE AND invoices.state = 'draft'::invoice_state");
    expect(s[2]).toContain("AND (TRUE) AND EXISTS (SELECT 1 FROM invoice_line_items");
    expect(s.some((q) => q.includes("still_lead"))).toBe(false);
  });

  it("office, request-less draft: scalar-subquery snapshot, no L_req, no still_lead", async () => {
    readQueue.push([{ service_request_id: null, synced: false }]);
    batch.mockResolvedValue(res([], [{ state: "open" }], [{ state: "open", lines: "1" }]));
    expect(await finalizeInvoice(OFFICE, INV)).toEqual({ ok: true, state: "open", changed: true });
    expect(params()).toEqual([2, 7, 4]);
    const s = stmts();
    expect(s[0]).toMatch(LOCK_INV);
    expect(s.some((q) => q.includes("FROM service_requests WHERE id"))).toBe(false);
    expect(s.some((q) => q.includes("still_lead"))).toBe(false);
    expect(s[1]).toContain("issued_at = now()");
    expect(s[1]).toContain("signature_url = (SELECT r.signature_url FROM service_requests r WHERE r.id = invoices.service_request_id AND r.organization_id = $1::uuid AND r.signed_at >= invoices.updated_at)");
    expect(s[1]).toContain("signature_name = (SELECT r.signature_name FROM service_requests r");
    expect(s[1]).toContain("signed_at = (SELECT r.signed_at FROM service_requests r");
    expect(s[1]).not.toContain("FROM service_requests r WHERE r.id = invoices.service_request_id AND r.organization_id = $4");
  });

  it("office on a synced invoice → synced_read_only before any write", async () => {
    readQueue.push([{ service_request_id: REQ, synced: true }]);
    expect(await finalizeInvoice(OFFICE, INV)).toEqual({ ok: false, reason: "synced_read_only" });
    expect(render(reads[0])).toContain("(fieldpulse_invoice_id IS NOT NULL OR hcp_invoice_id IS NOT NULL) AS synced");
    expect(batch).not.toHaveBeenCalled();
  });
});
