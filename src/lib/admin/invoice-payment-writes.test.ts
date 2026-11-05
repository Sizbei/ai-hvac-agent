import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Same harness as invoice-field-writes.test.ts: db.execute returns a thenable
// that carries its SQL (captured by db.batch) and, when awaited directly (a
// pre-read), resolves the next scripted `{ rows }` from readQueue.
const { readQueue, reads, batch, logError } = vi.hoisted(() => ({
  readQueue: [] as unknown[][],
  reads: [] as unknown[],
  batch: vi.fn(),
  logError: vi.fn(),
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
vi.mock("@/lib/logger", () => ({ logger: { error: logError, warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));

import { recordManualPayment, refundManualPayment } from "./invoice-payment-writes";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const INV = "44444444-4444-4444-8444-444444444444";
const PAY = "55555555-5555-4555-8555-555555555555";
const REF = "66666666-6666-4666-8666-666666666666";
const BY = "77777777-7777-4777-8777-777777777777";

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
const LOCK_PAY = /^SELECT 1 FROM payments WHERE id = \$1::uuid AND organization_id = \$2::uuid FOR NO KEY UPDATE$/;
const XMIN = "xmin = pg_current_xact_id()::xid";
const DEADLOCK = () => Object.assign(new Error("q"), { cause: { code: "40P01" } });

const CASH = { method: "cash" as const, amountCents: 5000, isDeposit: false, recordedBy: BY };
const CHECK = { method: "check" as const, amountCents: 5000, checkNumber: "1042", isDeposit: false, recordedBy: BY };
const payRow = (over: Record<string, unknown> = {}) => ({
  id: PAY, invoice_id: INV, amount_cents: 5000, method: "check", check_number: "1042", is_deposit: false, ...over,
});
const openInv = (over: Record<string, unknown> = {}) => ({
  service_request_id: REQ, state: "open", total_cents: 10000, amount_paid_cents: 0, synced: false, ...over,
});

beforeEach(() => {
  readQueue.length = 0;
  reads.length = 0;
  batch.mockReset();
  logError.mockReset();
});

describe("recordManualPayment — by-id read first", () => {
  it("a matching row replays created:false even when the invoice is paid (no batch)", async () => {
    readQueue.push([payRow()], [{ state: "paid" }]);
    const out = await recordManualPayment(TECH, INV, { paymentId: PAY }, CHECK);
    expect(out).toEqual({ ok: true, paymentId: PAY, invoiceState: "paid", created: false });
    const first = renderQ(reads[0]);
    expect(first.sql.replace(/\s+/g, " ").trim()).toBe(
      "SELECT id, invoice_id, amount_cents, method, check_number, is_deposit FROM payments WHERE id = $1::uuid",
    );
    expect(first.params).toEqual([PAY]);
    expect(render(reads[1])).toBe("SELECT state FROM invoices WHERE id = $1::uuid AND organization_id = $2::uuid");
    expect(batch).not.toHaveBeenCalled();
  });

  it("null check_number matches an absent checkNumber", async () => {
    readQueue.push([payRow({ method: "cash", check_number: null })], [{ state: "open" }]);
    expect(await recordManualPayment(TECH, INV, { paymentId: PAY }, CASH)).toEqual({ ok: true, paymentId: PAY, invoiceState: "open", created: false });
  });

  it.each([
    ["check_number", { check_number: "9999" }],
    ["is_deposit", { is_deposit: true }],
    ["method", { method: "cash" }],
    ["amount_cents", { amount_cents: 4999 }],
    ["invoice_id", { invoice_id: REQ }],
  ])("a row differing only in %s → payment_id_conflict before any precondition", async (_f, over) => {
    readQueue.push([payRow(over)]);
    expect(await recordManualPayment(TECH, INV, { paymentId: PAY }, CHECK)).toEqual({ ok: false, reason: "payment_id_conflict" });
    expect(reads).toHaveLength(1);
    expect(batch).not.toHaveBeenCalled();
  });
});

describe("recordManualPayment — preconditions", () => {
  it("not found / synced / not open / over balance, all before the batch", async () => {
    readQueue.push([], []);
    expect(await recordManualPayment(TECH, INV, { paymentId: PAY }, CASH)).toEqual({ ok: false, reason: "invoice_not_found" });
    const pre = renderQ(reads[1]);
    expect(pre.sql).toContain("(fieldpulse_invoice_id IS NOT NULL OR hcp_invoice_id IS NOT NULL) AS synced");
    expect(pre.sql).toContain("service_request_id = $3::uuid");
    expect(pre.params).toEqual([INV, ORG, REQ]);
    readQueue.push([], [openInv({ synced: true })]);
    expect(await recordManualPayment(TECH, INV, { paymentId: PAY }, CASH)).toEqual({ ok: false, reason: "synced_read_only" });
    readQueue.push([], [openInv({ state: "draft" })]);
    expect(await recordManualPayment(TECH, INV, { paymentId: PAY }, CASH)).toEqual({ ok: false, reason: "invoice_not_chargeable" });
    readQueue.push([], [openInv({ amount_paid_cents: 6000 })]);
    expect(await recordManualPayment(TECH, INV, { paymentId: PAY }, CASH)).toEqual({ ok: false, reason: "exceeds_balance" });
    expect(batch).not.toHaveBeenCalled();
  });

  it.each([0, -100, 12.5, Number.NaN])("a non-positive or fractional amount (%s) → exceeds_balance before any read", async (amountCents) => {
    expect(await recordManualPayment(TECH, INV, { paymentId: PAY }, { ...CASH, amountCents })).toEqual({ ok: false, reason: "exceeds_balance" });
    expect(reads).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
  });

  it("office: synced_read_only from the pre-read, no request predicate", async () => {
    readQueue.push([], [openInv({ synced: true })]);
    expect(await recordManualPayment(OFFICE, INV, { paymentId: PAY }, CASH)).toEqual({ ok: false, reason: "synced_read_only" });
    expect(renderQ(reads[1]).params).toEqual([INV, ORG]);
  });
});

describe("recordManualPayment — batch (tech)", () => {
  const created = () => res([], [], [{ amount_paid_cents: 10000, total_cents: 10000 }], [{ id: PAY }], [{ state: "paid" }], [payRow()], [{ state: "paid" }], [{ still_lead: true }]);

  it("created: statement order, gates, casts, param counts", async () => {
    readQueue.push([], [openInv({ amount_paid_cents: 5000 })]);
    batch.mockResolvedValue(created());
    expect(await recordManualPayment(TECH, INV, { paymentId: PAY }, CHECK)).toEqual({ ok: true, paymentId: PAY, invoiceState: "paid", created: true });
    const s = stmts();
    expect(s).toHaveLength(8);
    expect(params()).toEqual([2, 2, 10, 10, 3, 1, 2, 4]);
    expect(s[0]).toMatch(LOCK_REQ);
    expect(s[1]).toMatch(LOCK_INV);

    // claim
    expect(s[2]).toMatch(/^UPDATE invoices SET amount_paid_cents = amount_paid_cents \+ \$1::int, updated_at = now\(\) WHERE id = \$2::uuid AND organization_id = \$3::uuid/);
    expect(s[2]).toContain("AND (service_request_id = $4::uuid) AND state = 'open'::invoice_state AND fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL");
    expect(s[2]).toContain("AND amount_paid_cents + $5::int <= total_cents");
    expect(s[2]).toMatch(/AND NOT EXISTS \(SELECT 1 FROM payments WHERE id = \$6::uuid\) AND \(EXISTS \(SELECT 1 FROM appointment_assignments a/);
    expect(s[2]).toMatch(/RETURNING amount_paid_cents, total_cents$/);
    const guard = s[2].match(/NOT EXISTS \(SELECT 1 FROM payments WHERE id = [^)]*\)/)![0];
    expect(guard.match(/\$\d+/g)).toHaveLength(1);

    // insert gated on the invoice xmin
    expect(s[3]).toMatch(/^INSERT INTO payments \(id, organization_id, invoice_id, provider, provider_payment_id, amount_cents, status, is_deposit, method, check_number, recorded_by\)/);
    expect(s[3]).toContain("'manual', NULL, $4::int, 'succeeded'::payment_status");
    expect(s[3]).toContain(`WHERE EXISTS (SELECT 1 FROM invoices WHERE id = $9::uuid AND organization_id = $10::uuid AND ${XMIN})`);
    expect(s[3]).toMatch(/ON CONFLICT \(id\) DO NOTHING RETURNING id$/);
    const ins = renderQ((batch.mock.calls[0]![0] as unknown[])[3]).params;
    expect(ins).toEqual([PAY, ORG, INV, 5000, false, "check", "1042", BY, INV, ORG]);

    // state update gated on the PAYMENT row's xmin
    expect(s[4]).toMatch(/^UPDATE invoices SET state = \(CASE WHEN amount_paid_cents >= total_cents THEN 'paid' ELSE 'open' END\)::invoice_state, updated_at = now\(\)/);
    expect(s[4]).toContain(`EXISTS (SELECT 1 FROM payments WHERE id = $3::uuid AND ${XMIN})`);
    expect(s[4]).not.toContain("invoices.xmin");
    expect(s[4]).toMatch(/RETURNING state$/);

    expect(s[5]).toBe("SELECT id, invoice_id, amount_cents, method, check_number, is_deposit FROM payments WHERE id = $1::uuid");
    expect(s[6]).toBe("SELECT state FROM invoices WHERE id = $1::uuid AND organization_id = $2::uuid");
    expect(s[7]).toMatch(/^SELECT \(EXISTS .*\) AS still_lead$/);
    expect(logError).not.toHaveBeenCalled();
  });

  it("claim landed but the INSERT did not → invariant log with ids only", async () => {
    readQueue.push([], [openInv()]);
    batch.mockResolvedValue(res([], [], [{ amount_paid_cents: 5000, total_cents: 10000 }], [], [], [], [{ state: "open" }], [{ still_lead: true }]));
    const out = await recordManualPayment(TECH, INV, { paymentId: PAY }, CASH);
    expect(out).toEqual({ ok: true, paymentId: PAY, invoiceState: "open", created: true });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]![0]).toEqual({ organizationId: ORG, invoiceId: INV, paymentId: PAY });
  });

  it("claim empty: replay / conflict / not_lead / exceeds_balance / not_chargeable / not found", async () => {
    const run = async (payRows: unknown[], inv: unknown[], lead: boolean) => {
      readQueue.push([], [openInv()]);
      batch.mockResolvedValueOnce(res([], [], [], [], [], payRows, inv, [{ still_lead: lead }]));
      return recordManualPayment(TECH, INV, { paymentId: PAY }, CASH);
    };
    const cashRow = payRow({ method: "cash", check_number: null });
    expect(await run([cashRow], [{ state: "paid" }], true)).toEqual({ ok: true, paymentId: PAY, invoiceState: "paid", created: false });
    expect(await run([cashRow], [{ state: "paid" }], false)).toEqual({ ok: true, paymentId: PAY, invoiceState: "paid", created: false });
    expect(await run([payRow()], [{ state: "paid" }], true)).toEqual({ ok: false, reason: "payment_id_conflict" });
    expect(await run([], [{ state: "open" }], false)).toEqual({ ok: false, reason: "not_lead" });
    expect(await run([], [{ state: "open" }], true)).toEqual({ ok: false, reason: "exceeds_balance" });
    expect(await run([], [{ state: "paid" }], true)).toEqual({ ok: false, reason: "invoice_not_chargeable" });
    expect(await run([], [], true)).toEqual({ ok: false, reason: "invoice_not_found" });
  });

  it("a deadlock maps to stale", async () => {
    readQueue.push([], [openInv()]);
    batch.mockRejectedValue(DEADLOCK());
    expect(await recordManualPayment(TECH, INV, { paymentId: PAY }, CASH)).toEqual({ ok: false, reason: "stale" });
  });
});

describe("recordManualPayment — office", () => {
  it("with a request: L_req from the invoice, TRUE substitutions, no still_lead", async () => {
    readQueue.push([], [openInv()]);
    batch.mockResolvedValue(res([], [], [{ amount_paid_cents: 5000, total_cents: 10000 }], [{ id: PAY }], [{ state: "open" }], [payRow()], [{ state: "open" }]));
    const out = await recordManualPayment(OFFICE, INV, { paymentId: PAY }, { ...CASH, method: "other", isDeposit: true });
    expect(out).toEqual({ ok: true, paymentId: PAY, invoiceState: "open", created: true });
    expect(params()).toEqual([2, 2, 5, 10, 3, 1, 2]);
    const s = stmts();
    expect(s[0]).toMatch(LOCK_REQ);
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[0]).params).toEqual([REQ, ORG]);
    expect(s[1]).toMatch(LOCK_INV);
    expect(s[2]).toContain("AND (TRUE) AND state = 'open'::invoice_state");
    expect(s[2]).toMatch(/NOT EXISTS \(SELECT 1 FROM payments WHERE id = \$5::uuid\) AND \(TRUE\) RETURNING/);
    expect(s.some((q) => q.includes("still_lead"))).toBe(false);
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[3]).params).toEqual([PAY, ORG, INV, 5000, true, "other", null, BY, INV, ORG]);
  });

  it("request-less invoice: no L_req", async () => {
    readQueue.push([], [openInv({ service_request_id: null })]);
    batch.mockResolvedValue(res([], [], [], [], [], [{ state: "open" }]));
    expect(await recordManualPayment(OFFICE, INV, { paymentId: PAY }, CASH)).toEqual({ ok: false, reason: "exceeds_balance" });
    expect(params()).toEqual([2, 5, 10, 3, 1, 2]);
    const s = stmts();
    expect(s[0]).toMatch(LOCK_INV);
    expect(s.some((q) => q.includes("FROM service_requests"))).toBe(false);
  });
});

describe("refundManualPayment", () => {
  const refRow = (over: Record<string, unknown> = {}) => ({ payment_id: PAY, amount_cents: 5000, reason: "Overpaid", ...over });
  const manual = (over: Record<string, unknown> = {}) => ({
    invoice_id: INV, provider: "manual", status: "succeeded", amount_cents: 10000, amount_refunded_cents: 0, service_request_id: REQ, ...over,
  });

  it("by-id read first: a matching row replays without any precondition", async () => {
    readQueue.push([refRow()]);
    expect(await refundManualPayment(ORG, PAY, { refundId: REF }, { amountCents: 5000, reason: "Overpaid" })).toEqual({ ok: true, refundId: REF, created: false });
    const first = renderQ(reads[0]);
    expect(first.sql.replace(/\s+/g, " ").trim()).toBe("SELECT payment_id, amount_cents, reason FROM refunds WHERE id = $1::uuid");
    expect(first.params).toEqual([REF]);
    expect(reads).toHaveLength(1);
    expect(batch).not.toHaveBeenCalled();
    readQueue.push([refRow({ reason: null })]);
    expect(await refundManualPayment(ORG, PAY, { refundId: REF }, { amountCents: 5000 })).toEqual({ ok: true, refundId: REF, created: false });
  });

  it.each([
    ["reason", { reason: "Other" }],
    ["amount_cents", { amount_cents: 1 }],
    ["payment_id", { payment_id: INV }],
  ])("a row differing only in %s → refund_id_conflict", async (_f, over) => {
    readQueue.push([refRow(over)]);
    expect(await refundManualPayment(ORG, PAY, { refundId: REF }, { amountCents: 5000, reason: "Overpaid" })).toEqual({ ok: false, reason: "refund_id_conflict" });
    expect(batch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, Number.NaN])("a non-positive or fractional amount (%s) → exceeds_payment before any read", async (amountCents) => {
    expect(await refundManualPayment(ORG, PAY, { refundId: REF }, { amountCents })).toEqual({ ok: false, reason: "exceeds_payment" });
    expect(reads).toHaveLength(0);
    expect(batch).not.toHaveBeenCalled();
  });

  it("preconditions: not found / not manual / not succeeded / over the payment", async () => {
    const run = (row: unknown[], amt = 5000) => {
      readQueue.push([], row);
      return refundManualPayment(ORG, PAY, { refundId: REF }, { amountCents: amt });
    };
    expect(await run([])).toEqual({ ok: false, reason: "payment_not_found" });
    expect(renderQ(reads[1]).sql).toContain("p.organization_id = $");
    expect(renderQ(reads[1]).sql).toContain("i.organization_id = $");
    expect(await run([manual({ provider: "mock" })])).toEqual({ ok: false, reason: "not_refundable" });
    expect(await run([manual({ status: "refunded" })])).toEqual({ ok: false, reason: "not_refundable" });
    expect(await run([manual({ amount_refunded_cents: 6000 })])).toEqual({ ok: false, reason: "exceeds_payment" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("created: order, payment lock, claim CASE, xmin gates, GREATEST, param counts", async () => {
    readQueue.push([], [manual()]);
    batch.mockResolvedValue(res([], [], [], [{ id: PAY }], [{ id: REF }], [], [refRow()], [{ state: "open" }], [{ status: "succeeded" }]));
    expect(await refundManualPayment(ORG, PAY, { refundId: REF }, { amountCents: 5000, reason: "Overpaid" })).toEqual({ ok: true, refundId: REF, created: true });
    const s = stmts();
    expect(params()).toEqual([2, 2, 2, 6, 7, 5, 1, 2, 2]);
    expect(s[0]).toMatch(LOCK_REQ);
    expect(s[1]).toMatch(LOCK_INV);
    expect(s[2]).toMatch(LOCK_PAY);
    expect(s[3]).toMatch(/^UPDATE payments SET amount_refunded_cents = amount_refunded_cents \+ \$1::int, status = \(CASE WHEN amount_refunded_cents \+ \$2::int >= amount_cents THEN 'refunded' ELSE 'succeeded' END\)::payment_status, updated_at = now\(\)/);
    expect(s[3]).toContain("AND provider = 'manual' AND status = 'succeeded'::payment_status AND amount_refunded_cents + $5::int <= amount_cents");
    const guard = s[3].match(/NOT EXISTS \(SELECT 1 FROM refunds WHERE id = [^)]*\)/)![0];
    expect(guard.match(/\$\d+/g)).toHaveLength(1);
    expect(s[3]).toMatch(/RETURNING id$/);
    expect(s[4]).toMatch(/^INSERT INTO refunds \(id, organization_id, payment_id, amount_cents, reason, provider_refund_id\)/);
    expect(s[4]).toContain(`WHERE EXISTS (SELECT 1 FROM payments WHERE id = $6::uuid AND organization_id = $7::uuid AND ${XMIN})`);
    expect(s[4]).toMatch(/ON CONFLICT \(id\) DO NOTHING RETURNING id$/);
    expect(s[5]).toMatch(/^UPDATE invoices SET amount_paid_cents = GREATEST\(0, amount_paid_cents - \$1::int\), state = \(CASE WHEN GREATEST\(0, amount_paid_cents - \$2::int\) >= total_cents THEN 'paid' ELSE 'open' END\)::invoice_state/);
    expect(s[5]).toContain(`EXISTS (SELECT 1 FROM refunds WHERE id = $5::uuid AND ${XMIN})`);
    expect(s[5]).not.toContain("payments");
    expect(s[6]).toBe("SELECT payment_id, amount_cents, reason FROM refunds WHERE id = $1::uuid");
    expect(s[7]).toBe("SELECT state FROM invoices WHERE id = $1::uuid AND organization_id = $2::uuid");
    expect(s[8]).toBe("SELECT status FROM payments WHERE id = $1::uuid AND organization_id = $2::uuid");
  });

  it("request-less invoice: no L_req", async () => {
    readQueue.push([], [manual({ service_request_id: null })]);
    batch.mockResolvedValue(res([], [], [{ id: PAY }], [{ id: REF }], [], [refRow({ reason: null })], [{ state: "open" }], [{ status: "refunded" }]));
    expect(await refundManualPayment(ORG, PAY, { refundId: REF }, { amountCents: 5000 })).toEqual({ ok: true, refundId: REF, created: true });
    expect(params()).toEqual([2, 2, 6, 7, 5, 1, 2, 2]);
    expect(stmts()[0]).toMatch(LOCK_INV);
  });

  it("claim empty: replay / conflict / exceeds_payment / not_refundable / stale", async () => {
    const run = async (refRows: unknown[], status: string | null) => {
      readQueue.push([], [manual()]);
      batch.mockResolvedValueOnce(res([], [], [], [], [], [], refRows, [{ state: "open" }], status ? [{ status }] : []));
      return refundManualPayment(ORG, PAY, { refundId: REF }, { amountCents: 5000, reason: "Overpaid" });
    };
    expect(await run([refRow()], "succeeded")).toEqual({ ok: true, refundId: REF, created: false });
    expect(await run([refRow({ reason: "x" })], "succeeded")).toEqual({ ok: false, reason: "refund_id_conflict" });
    expect(await run([], "succeeded")).toEqual({ ok: false, reason: "exceeds_payment" });
    expect(await run([], "refunded")).toEqual({ ok: false, reason: "not_refundable" });
    expect(await run([], null)).toEqual({ ok: false, reason: "not_refundable" });
    readQueue.push([], [manual()]);
    batch.mockRejectedValueOnce(DEADLOCK());
    expect(await refundManualPayment(ORG, PAY, { refundId: REF }, { amountCents: 5000 })).toEqual({ ok: false, reason: "stale" });
  });
});
