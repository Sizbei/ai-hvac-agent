import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  takePayment,
  listInvoices,
  getInvoiceDetailById,
  reconcilePayment,
  listStuckPayments,
} from "./invoice-queries";
import { db } from "@/lib/db";
import { MockPaymentProvider } from "@/lib/payments/provider";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// `cards.on` drives the mocked card gate (true = the pre-M3b behaviour under
// test); `refundManualPayment` is Task 5's writer, mocked to assert delegation.
const h = vi.hoisted(() => ({ cards: { on: true }, refundManualPayment: vi.fn() }));
vi.mock("@/lib/payments/card-enabled", () => ({ cardPaymentsEnabled: () => h.cards.on }));
vi.mock("./invoice-payment-writes", () => ({ refundManualPayment: h.refundManualPayment }));

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    // Raw statements: a thenable carrying its SQL so db.batch can capture it.
    execute: vi.fn((q: unknown) => ({ __sql: q, then: (ok: (v: unknown) => unknown) => Promise.resolve({ rows: [] }).then(ok) })),
    batch: vi.fn().mockResolvedValue([]),
    // update() is used to BUILD statements (passed to batch), directly in the
    // charge-failed/invoice-credit paths, AND for the reconcile CAS claim
    // (.where().returning()). where() resolves harmlessly when awaited and also
    // exposes .returning() defaulting to a WON claim (one row).
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve(undefined), {
            returning: vi.fn().mockResolvedValue([{ id: "pay-1" }]),
          }),
        ),
      })),
    })),
  },
}));

const ORG = "org-1";

const dialect = new PgDialect();
const renderQ = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL);
const render = (q: unknown): string => renderQ(q).sql.replace(/\s+/g, " ").trim();
/** The rendered statements of the Nth db.batch call. */
const batchStmts = (n = 0): unknown[] => vi.mocked(db.batch).mock.calls[n]![0] as unknown as unknown[];

function mockInvoice(
  row: { totalCents: number; amountPaidCents: number; state?: string } | null,
) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi
          .fn()
          .mockResolvedValue(row ? [{ id: "inv-1", state: "open", ...row }] : []),
      }),
    }),
  } as never);
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cards.on = true;
});

describe("takePayment", () => {
  const provider = new MockPaymentProvider();

  // Configures db.update's claim RETURNING to yield the given POST-claim
  // amountPaidCents/totalCents — the values takePayment must now derive
  // invoiceState from (never the pre-claim `inv` read).
  function mockClaimReturning(amountPaidCents: number, totalCents: number) {
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: vi.fn(() => ({
            where: vi.fn(() =>
              Object.assign(Promise.resolve(undefined), {
                returning: vi
                  .fn()
                  .mockResolvedValue([{ id: "inv-1", amountPaidCents, totalCents }]),
              }),
            ),
          })),
        }) as never,
    );
  }

  it("marks the invoice paid when fully covered", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    mockClaimReturning(10000, 10000);
    const r = await takePayment(ORG, "inv-1", { amountCents: 10000 }, provider);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invoiceState).toBe("paid");
    expect(db.batch).toHaveBeenCalledTimes(1); // payment + invoice update batched
  });

  // The claim-time derivation is computed BEFORE provider.createCharge(), an
  // async network call. Two concurrent partial payments can resolve out of
  // claim-order, so writing a JS-computed literal lets the loser overwrite
  // 'paid' back to 'open'. The final write must therefore be a SQL expression
  // Postgres evaluates against the row's own columns at write time. This test
  // fails if the write reverts to a plain "paid"/"open" string.
  it("writes invoice state as a SQL expression evaluated at write time, not a precomputed literal", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const setPayloads: Record<string, unknown>[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            setPayloads.push(v);
            return {
              where: vi.fn(() =>
                Object.assign(Promise.resolve(undefined), {
                  returning: vi
                    .fn()
                    .mockResolvedValue([
                      { id: "inv-1", amountPaidCents: 10000, totalCents: 10000 },
                    ]),
                }),
              ),
            };
          },
        }) as never,
    );

    await takePayment(ORG, "inv-1", { amountCents: 10000 }, provider);

    const stateWrites = setPayloads.filter((p) => "state" in p);
    expect(stateWrites.length).toBeGreaterThan(0);
    for (const write of stateWrites) {
      expect(typeof write.state).not.toBe("string");
    }
  });

  // 42804 regression: invoices.state is a Postgres ENUM (invoice_state). A bare
  // CASE resolves its 'paid'/'open' branches to text, and Postgres refuses
  // text → enum in an UPDATE assignment — the finalize batch threw, stranding
  // every native payment 'pending' with the invoice left 'open' (found live via
  // the portal pay flow). The SQL expression must carry an explicit
  // ::invoice_state cast; this test fails if the cast is dropped.
  it("casts the SQL-derived state to the invoice_state enum (42804 regression)", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const setPayloads: Record<string, unknown>[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            setPayloads.push(v);
            return {
              where: vi.fn(() =>
                Object.assign(Promise.resolve(undefined), {
                  returning: vi
                    .fn()
                    .mockResolvedValue([
                      { id: "inv-1", amountPaidCents: 10000, totalCents: 10000 },
                    ]),
                }),
              ),
            };
          },
        }) as never,
    );

    await takePayment(ORG, "inv-1", { amountCents: 10000 }, provider);

    const stateWrites = setPayloads.filter((p) => "state" in p);
    expect(stateWrites.length).toBeGreaterThan(0);
    // Collect the literal string fragments of a drizzle sql`` expression
    // (queryChunks → StringChunk.value) without serializing table objects,
    // which are circular.
    const flattenChunks = (expr: unknown): string => {
      const out: string[] = [];
      const visit = (node: unknown): void => {
        if (typeof node === "string") {
          out.push(node);
          return;
        }
        if (Array.isArray(node)) {
          node.forEach(visit);
          return;
        }
        if (node && typeof node === "object") {
          const rec = node as { queryChunks?: unknown; value?: unknown };
          if (rec.queryChunks !== undefined) visit(rec.queryChunks);
          if (rec.value !== undefined) visit(rec.value);
        }
      };
      visit(expr);
      return out.join("");
    };
    for (const write of stateWrites) {
      expect(flattenChunks(write.state)).toContain("::invoice_state");
    }
  });

  it("keeps the invoice open on a partial deposit", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    mockClaimReturning(5000, 10000);
    const r = await takePayment(ORG, "inv-1", { amountCents: 5000, isDeposit: true }, provider);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invoiceState).toBe("open");
  });

  // B7 regression: two concurrent partial payments that together exactly fill
  // the balance. This call's OWN pre-claim read (via mockInvoice) sees
  // amountPaidCents: 0 — taken before either claim landed. But by the time
  // THIS claim's atomic increment actually runs, a concurrent payment already
  // landed 5000, so the claim's RETURNING row reflects the true post-claim
  // total: 10000 (fully paid). Deriving from the stale pre-claim read would
  // compute 0 + 5000 = 5000 < 10000 -> 'open', permanently stranding a
  // fully-paid invoice in the collections queue (state is never revisited
  // after this write). The fix must derive from the claim's RETURNING row.
  it("derives invoiceState from the POST-claim row, not the pre-claim stale read (B7)", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    mockClaimReturning(10000, 10000);
    const r = await takePayment(ORG, "inv-1", { amountCents: 5000 }, provider);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invoiceState).toBe("paid");
  });

  it("returns invoice_not_found when the invoice is missing", async () => {
    mockInvoice(null);
    const r = await takePayment(ORG, "inv-x", { amountCents: 5000 }, provider);
    expect(r).toEqual({ ok: false, reason: "invoice_not_found" });
  });

  it("rejects a non-positive amount (exceeds_balance) before hitting the provider", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const r = await takePayment(ORG, "inv-1", { amountCents: 0 }, provider);
    expect(r).toEqual({ ok: false, reason: "exceeds_balance" });
  });

  it("rejects over-collection (amount > remaining balance) — never charge past the total", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 8000 }); // only 2000 left
    const r = await takePayment(ORG, "inv-1", { amountCents: 5000 }, provider);
    expect(r).toEqual({ ok: false, reason: "exceeds_balance" });
  });

  // Concurrency guard: the invoice credit must be an ATOMIC SQL increment off the
  // current row, NOT a precomputed absolute value (which lost-updates when two
  // payments race — e.g. a customer double-submitting the portal pay form). We
  // can't run a real race against a mocked db, so we lock in the invariant: the
  // amountPaidCents written is a SQL expression, never a plain number. Kept LAST
  // in this block because it overrides the shared db.update mock.
  it("credits the invoice with an atomic increment, not a precomputed absolute", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const sets: Record<string, unknown>[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            sets.push(v);
            // .where() is awaitable AND exposes .returning() (the atomic CLAIM).
            return {
              where: vi.fn(() =>
                Object.assign(Promise.resolve(undefined), {
                  returning: vi.fn().mockResolvedValue([{ id: "inv-1" }]),
                }),
              ),
            };
          },
        }) as never,
    );
    const r = await takePayment(ORG, "inv-1", { amountCents: 5000 }, provider);
    expect(r.ok).toBe(true);
    // The reserve credits amountPaidCents via a SQL expression, never a number.
    const invSet = sets.find((s) => "amountPaidCents" in s);
    expect(invSet).toBeDefined();
    expect(typeof invSet?.amountPaidCents).not.toBe("number");
  });

  // The atomic claim is the authoritative race guard: when a concurrent charge
  // already reserved the balance, this call's conditional UPDATE matches 0 rows
  // and we must reject WITHOUT charging the card (no double-charge).
  it("returns exceeds_balance and never charges when the claim is lost", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    // Override db.update so the claim's .returning() yields NO row (claim lost).
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: () => ({
            where: vi.fn(() =>
              Object.assign(Promise.resolve(undefined), {
                returning: vi.fn().mockResolvedValue([]),
              }),
            ),
          }),
        }) as never,
    );
    const chargeSpy = vi.spyOn(provider, "createCharge");
    const r = await takePayment(ORG, "inv-1", { amountCents: 5000 }, provider);
    expect(r).toEqual({ ok: false, reason: "exceeds_balance" });
    expect(chargeSpy).not.toHaveBeenCalled();
    chargeSpy.mockRestore();
  });

  // A THROW after the claim (payment insert or a network error on createCharge)
  // must also un-claim, or the invoice is permanently over-credited — and an
  // insert-throw leaves no pending row for reconciliation to ever find.
  it("un-claims (decrements) the invoice when createCharge throws", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const sets: Record<string, unknown>[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            sets.push(v);
            return {
              where: vi.fn(() =>
                Object.assign(Promise.resolve(undefined), {
                  returning: vi.fn().mockResolvedValue([{ id: "inv-1" }]),
                  catch: (cb: () => void) => Promise.resolve(undefined).catch(cb),
                }),
              ),
            };
          },
        }) as never,
    );
    vi.spyOn(provider, "createCharge").mockRejectedValueOnce(new Error("network timeout"));
    await expect(
      takePayment(ORG, "inv-1", { amountCents: 5000 }, provider),
    ).rejects.toThrow("network timeout");
    // The compensating decrement ran (a SQL expression off the current row).
    const dec = sets.find((s) => "amountPaidCents" in s);
    expect(dec).toBeDefined();
    expect(typeof dec?.amountPaidCents).not.toBe("number");
  });

  // A failed charge must UN-CLAIM: release the reserved balance (so a later
  // legitimate charge isn't blocked) and mark the payment failed.
  it("un-claims the reserved balance when the charge fails", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    // Restore a WON claim (a prior test may have overridden db.update; clearAllMocks
    // doesn't restore implementations). .where() is awaitable (for batched builds)
    // and exposes .returning() (for the claim).
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: vi.fn(() => ({
            where: vi.fn(() =>
              Object.assign(Promise.resolve(undefined), {
                returning: vi.fn().mockResolvedValue([{ id: "inv-1" }]),
              }),
            ),
          })),
        }) as never,
    );
    vi.spyOn(provider, "createCharge").mockResolvedValueOnce({
      status: "failed",
    } as never);
    const r = await takePayment(ORG, "inv-1", { amountCents: 5000 }, provider);
    expect(r).toEqual({ ok: false, reason: "charge_failed" });
    // payment-failed + invoice-decrement batched together (the un-claim).
    expect(db.batch).toHaveBeenCalledTimes(1);
  });
});

import { createInvoiceFromSoldEstimate, refundPayment } from "./invoice-queries";

// ---------------------------------------------------------------------------
// createInvoiceFromSoldEstimate — materialize an invoice from a SOLD estimate.
// Sequences the db.select calls: 1) estimate, 2) existing-invoice (idempotency),
// 3) option totals, 4) line items.
// ---------------------------------------------------------------------------

/** Sequence db.select results; each where() is awaitable AND .limit()-able. */
function mockCreateSeq(results: unknown[][]): void {
  let i = 0;
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({
          where: () => {
            const r = results[i++] ?? [];
            const p = Promise.resolve(r);
            return Object.assign(p, { limit: () => Promise.resolve(r), orderBy: () => Promise.resolve(r) });
          },
        }),
      }) as never,
  );
}

describe("createInvoiceFromSoldEstimate", () => {
  beforeEach(() => {
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn(() => ({})) } as never);
  });

  it("is idempotent: a second call returns the EXISTING invoice id, no new invoice", async () => {
    mockCreateSeq([
      [{ id: "est-1", status: "sold", soldOptionId: "opt-1", customerId: "c", serviceRequestId: null }],
      [{ id: "inv-existing" }], // an invoice already exists for this estimate
    ]);
    const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
    expect(r).toEqual({ ok: true, invoiceId: "inv-existing", created: false });
    // No insert/batch — we returned the existing invoice instead of duplicating.
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("rejects a non-sold estimate (estimate_not_sold)", async () => {
    mockCreateSeq([
      [{ id: "est-1", status: "open", soldOptionId: null, customerId: "c", serviceRequestId: null }],
    ]);
    const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
    expect(r).toEqual({ ok: false, reason: "estimate_not_sold" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("rejects a missing estimate (estimate_not_sold)", async () => {
    mockCreateSeq([[]]);
    const r = await createInvoiceFromSoldEstimate(ORG, "est-x");
    expect(r).toEqual({ ok: false, reason: "estimate_not_sold" });
  });

  it("rejects a sold estimate with no soldOptionId (no_sold_option)", async () => {
    mockCreateSeq([
      [{ id: "est-1", status: "sold", soldOptionId: null, customerId: "c", serviceRequestId: null }],
    ]);
    const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
    expect(r).toEqual({ ok: false, reason: "no_sold_option" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("creates an invoice (state 'open') from the sold option's snapshot on first call (no request)", async () => {
    const valuesSpy = vi.fn((v: unknown) => v);
    vi.mocked(db.insert).mockReturnValue({ values: valuesSpy } as never);
    mockCreateSeq([
      [{ id: "est-1", status: "sold", soldOptionId: "opt-1", customerId: "c", serviceRequestId: null }],
      [], // no existing invoice yet
      [{ subtotalCents: 9000, taxCents: 1000, totalCents: 10000 }], // option totals
      [{ id: "el-1", name: "Repair", quantity: 1, unitPriceCents: 9000, costCents: 4000, lineTotalCents: 9000 }],
    ]);
    const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invoiceId).toBeTruthy();
    // invoice insert + line-items insert batched atomically; no request → no lock.
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(db.execute).not.toHaveBeenCalled();
    // Born open (never draft): billed(eid)'s job half (jbi.estimate_id IS NULL) relies on it.
    expect(valuesSpy.mock.calls[0]![0]).toMatchObject({ estimateId: "est-1", state: "open" });
    const lineRows = valuesSpy.mock.calls.map((c) => c[0]).find(Array.isArray) as { id: string; estimateLineItemId: string }[];
    expect(lineRows[0]!.estimateLineItemId).toBe("el-1");
    expect(lineRows[0]!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/); // v7
  });

  describe("with a service request (spec §5.8)", () => {
    const EST = { id: "est-1", status: "sold", soldOptionId: "opt-1", customerId: "c", serviceRequestId: "req-1" };
    const OPT = { subtotalCents: 9000, taxCents: 1000, totalCents: 10000 };
    const LINE = { id: "el-1", name: "Repair", quantity: 1, unitPriceCents: 9000, costCents: 4000, lineTotalCents: 9000 };

    it("returns the existing estimate invoice FIRST, before any lock", async () => {
      mockCreateSeq([[EST], [{ id: "inv-existing" }]]);
      const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
      expect(r).toEqual({ ok: true, invoiceId: "inv-existing", created: false });
      expect(db.execute).not.toHaveBeenCalled();
      expect(db.batch).not.toHaveBeenCalled();
    });

    it("locks the request, then inserts only when no native draft exists and the job's invoice does not hold the lines; lines linked and xmin-gated", async () => {
      mockCreateSeq([[EST], [], [OPT], [LINE]]);
      vi.mocked(db.batch).mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "x" }] }, { rows: [] }] as never);
      const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
      expect(r.ok).toBe(true);
      const [lock, insert, lines] = batchStmts().map(render);
      expect(batchStmts()).toHaveLength(3);
      expect(lock).toContain("FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
      // Born open (never draft): billed(eid)'s job half (jbi.estimate_id IS NULL) relies on it.
      expect(insert).toMatch(/^INSERT INTO invoices .* SELECT .*'open'::invoice_state/);
      expect(insert).not.toContain("'draft'::invoice_state,");
      expect(insert).toContain(
        "WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE organization_id = $9::uuid AND service_request_id = $10::uuid AND state = 'draft'::invoice_state AND fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL) AND NOT EXISTS (SELECT 1 FROM invoice_line_items jbx",
      );
      expect(insert).toContain("jbi.estimate_id IS NULL");
      expect(insert.endsWith("ON CONFLICT DO NOTHING RETURNING id")).toBe(true);
      expect(renderQ(batchStmts()[1]).params).toHaveLength(15);
      expect(lines).toMatch(/^INSERT INTO invoice_line_items \(id, organization_id, invoice_id, estimate_line_item_id, name,/);
      expect(lines).toContain("WHERE EXISTS (SELECT 1 FROM invoices WHERE id = $");
      expect(lines).toContain("xmin = pg_current_xact_id()::xid)");
      // 1 line × (id, estimate line, name, qty, price, cost, total) + org + invoice + (invoice, org) in the gate
      expect(renderQ(batchStmts()[2]).params).toHaveLength(11);
      expect(renderQ(batchStmts()[2]).params).toContain("el-1");
    });

    it("returns the job's invoice when the field bill already holds the estimate's lines", async () => {
      mockCreateSeq([[EST], [], [OPT], [LINE], [], [{ invoiceId: "inv-job" }]]);
      vi.mocked(db.batch).mockResolvedValueOnce([{ rows: [] }, { rows: [] }, { rows: [] }] as never);
      const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
      expect(r).toEqual({ ok: true, invoiceId: "inv-job", created: false });
    });

    it("refuses with request_has_draft when the INSERT returns no row", async () => {
      mockCreateSeq([[EST], [], [OPT], [LINE], []]);
      vi.mocked(db.batch).mockResolvedValueOnce([{ rows: [] }, { rows: [] }, { rows: [] }] as never);
      const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
      expect(r).toEqual({ ok: false, reason: "request_has_draft" });
    });

    it("returns the estimate's invoice when a concurrent create won the estimate unique index", async () => {
      mockCreateSeq([[EST], [], [OPT], [], [{ id: "inv-raced" }]]);
      vi.mocked(db.batch).mockResolvedValueOnce([{ rows: [] }, { rows: [] }] as never);
      const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
      expect(r).toEqual({ ok: true, invoiceId: "inv-raced", created: false });
      expect(batchStmts()).toHaveLength(2); // no lines → no lines INSERT
    });
  });
});

import { takePayment as takePaymentFlow } from "./invoice-queries";
import { markEstimateSold } from "./estimate-queries";

// ---------------------------------------------------------------------------
// Money-loop FLOW: createEstimate -> markEstimateSold -> createInvoiceFromSoldEstimate
// -> takePayment(full) -> refundPayment(partial). Asserts the invoice state at
// each step (sold, open->paid, paid stays paid on a partial refund). DB is mocked;
// db.select calls are sequenced per step like the refund tests above.
// ---------------------------------------------------------------------------

describe("money-loop flow (mocked db)", () => {
  const provider = new MockPaymentProvider();

  beforeEach(() => {
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn(() => ({})) } as never);
  });

  it("walks sold -> invoiced(open) -> paid -> paid (after partial refund)", async () => {
    // 1) markEstimateSold: estimate is open, option belongs to it -> sold.
    mockCreateSeq([
      [{ id: "est-1", status: "open" }],
      [{ id: "opt-1" }],
    ]);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn(() => ({
        where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([{ id: "est-1" }]) })),
      })),
    } as never);
    const sold = await markEstimateSold(ORG, "est-1", "opt-1");
    expect(sold).toEqual({ ok: true, estimateId: "est-1" });

    // 2) createInvoiceFromSoldEstimate: sold estimate, no prior invoice -> open invoice.
    mockCreateSeq([
      [{ id: "est-1", status: "sold", soldOptionId: "opt-1", customerId: "c", serviceRequestId: null }],
      [], // no existing invoice
      [{ subtotalCents: 10000, taxCents: 0, totalCents: 10000 }],
      [{ name: "Repair", quantity: 1, unitPriceCents: 10000, costCents: 4000, lineTotalCents: 10000 }],
    ]);
    const created = await createInvoiceFromSoldEstimate(ORG, "est-1");
    expect(created.ok).toBe(true);

    // 3) takePayment(full): open -> paid. The claim's RETURNING row (not the
    // markEstimateSold-era db.update mock from step 1) must drive invoiceState.
    mockCreateSeq([[{ id: "inv-1", state: "open", totalCents: 10000, amountPaidCents: 0 }]]);
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: vi.fn(() => ({
            where: vi.fn(() =>
              Object.assign(Promise.resolve(undefined), {
                returning: vi
                  .fn()
                  .mockResolvedValue([{ id: "inv-1", amountPaidCents: 10000, totalCents: 10000 }]),
              }),
            ),
          })),
        }) as never,
    );
    const paid = await takePaymentFlow(ORG, "inv-1", { amountCents: 10000 }, provider);
    expect(paid.ok).toBe(true);
    if (paid.ok) expect(paid.invoiceState).toBe("paid");

    // 4) refundPayment(partial) of a fully-paid invoice: stays 'paid' (NOT chargeable).
    mockCreateSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, amountRefundedCents: 0, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [{ amountPaidCents: 10000, totalCents: 10000 }], // invoice was fully paid
    ]);
    const states: Record<string, unknown>[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            states.push(v);
            return {
              where: vi.fn(() =>
                Object.assign(Promise.resolve(undefined), {
                  returning: vi.fn().mockResolvedValue([{ id: "pay-1" }]),
                }),
              ),
            };
          },
        }) as never,
    );
    const refunded = await refundPayment(ORG, "pay-1", { amountCents: 4000 }, provider);
    expect(refunded.ok).toBe(true);
    // The paid-stays-paid rule now lives in the SQL CASE (render-tested below).
    expect(render(states.find((s) => "state" in s)?.state)).toContain("THEN 'paid'");
  });
});

/** Sequence db.select results across calls; each where() is awaitable AND .limit()-able. */
function mockSelectSeq(results: unknown[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({
          where: () => {
            const r = results[i++] ?? [];
            const p = Promise.resolve(r);
            return Object.assign(p, { limit: () => Promise.resolve(r) });
          },
        }),
      }) as never,
  );
}

describe("refundPayment", () => {
  const provider = new MockPaymentProvider();
  beforeEach(() => {
    vi.mocked(db.insert).mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) } as never);
  });

  it("refunds a succeeded payment within its balance", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, amountRefundedCents: 0, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [{ amountPaidCents: 10000, totalCents: 10000 }], // invoice
    ]);
    const r = await refundPayment("org-1", "pay-1", { amountCents: 4000 }, provider);
    expect(r.ok).toBe(true);
  });

  it("refuses to refund a non-succeeded payment", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, status: "pending", providerPaymentId: null }],
    ]);
    const r = await refundPayment("org-1", "pay-1", { amountCents: 1000 }, provider);
    expect(r).toEqual({ ok: false, reason: "not_refundable" });
  });

  // The atomic claim is the authoritative over-refund guard: when a concurrent
  // refund already reserved the balance, this call's conditional UPDATE matches
  // 0 rows and must reject WITHOUT calling the provider (no over-refund).
  it("returns exceeds_payment and never calls the provider when the claim is lost", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, amountRefundedCents: 0, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [{ amountPaidCents: 10000, totalCents: 10000 }],
    ]);
    // Claim UPDATE returns NO row (a concurrent refund won the reservation).
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: () => ({
            where: vi.fn(() =>
              Object.assign(Promise.resolve(undefined), {
                returning: vi.fn().mockResolvedValue([]),
              }),
            ),
          }),
        }) as never,
    );
    const refundSpy = vi.fn();
    const spyProvider = { name: "mock", createCharge: vi.fn(), refund: refundSpy };
    const r = await refundPayment("org-1", "pay-1", { amountCents: 4000 }, spyProvider as never);
    expect(r).toEqual({ ok: false, reason: "exceeds_payment" });
    expect(refundSpy).not.toHaveBeenCalled();
  });

  it("blocks over-refunding beyond the remaining balance", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, amountRefundedCents: 7000, status: "succeeded", providerPaymentId: "mock_pay_x" }],
    ]);
    const r = await refundPayment("org-1", "pay-1", { amountCents: 5000 }, provider);
    expect(r).toEqual({ ok: false, reason: "exceeds_payment" });
  });

  // Captures the set() payloads passed to db.update so we can assert the invoice
  // state the refund writes.
  function captureUpdateStates(): Record<string, unknown>[] {
    const states: Record<string, unknown>[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            states.push(v);
            return {
              where: vi.fn(() =>
                Object.assign(Promise.resolve(undefined), {
                  returning: vi.fn().mockResolvedValue([{ id: "pay-1" }]),
                }),
              ),
            };
          },
        }) as never,
    );
    return states;
  }

  it("writes the invoice state as a SQL CASE on the row being updated — no JS literal (spec §5.6)", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, amountRefundedCents: 0, status: "succeeded", providerPaymentId: "mock_pay_x", provider: "mock" }],
      [{ amountPaidCents: 10000, totalCents: 10000 }],
    ]);
    const states = captureUpdateStates();
    const r = await refundPayment("org-1", "pay-1", { amountCents: 4000 }, provider);
    expect(r).toEqual({ ok: true, refundId: expect.any(String), created: true });
    const invoiceSet = states.find((s) => "state" in s && "amountPaidCents" in s);
    expect(typeof invoiceSet?.state).not.toBe("string");
    const q = renderQ(invoiceSet?.state);
    expect(q.sql.replace(/\s+/g, " ")).toBe(
      `(CASE WHEN GREATEST(0, "invoices"."amount_paid_cents" - $1) <= 0 THEN 'refunded' WHEN GREATEST(0, "invoices"."amount_paid_cents" - $2) >= "invoices"."total_cents" OR "invoices"."state" = 'paid'::invoice_state THEN 'paid' ELSE 'open' END)::invoice_state`,
    );
    // Only the amount is a parameter — the state is never a bound literal.
    expect(q.params).toEqual([4000, 4000]);
  });

  describe("manual payments delegate to refundManualPayment (spec §5.6)", () => {
    const MANUAL = { id: "pay-1", invoiceId: "inv-1", amountCents: 10000, amountRefundedCents: 0, status: "succeeded", providerPaymentId: null, provider: "manual" };

    it("delegates with the refundId and maps created through; never calls the provider", async () => {
      mockSelectSeq([[MANUAL]]);
      h.refundManualPayment.mockResolvedValueOnce({ ok: true, refundId: "ref-1", created: false });
      const refundSpy = vi.fn();
      const r = await refundPayment("org-1", "pay-1", { amountCents: 4000, reason: "dup", refundId: "ref-1" }, { name: "mock", refund: refundSpy } as never);
      expect(r).toEqual({ ok: true, refundId: "ref-1", created: false });
      expect(h.refundManualPayment).toHaveBeenCalledWith("org-1", "pay-1", { refundId: "ref-1" }, { amountCents: 4000, reason: "dup" });
      expect(refundSpy).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it("passes the writer's refusal through", async () => {
      mockSelectSeq([[MANUAL]]);
      h.refundManualPayment.mockResolvedValueOnce({ ok: false, reason: "refund_id_conflict" });
      const r = await refundPayment("org-1", "pay-1", { amountCents: 4000, refundId: "ref-1" });
      expect(r).toEqual({ ok: false, reason: "refund_id_conflict" });
    });

    it("refuses a non-positive or fractional amount before delegating", async () => {
      for (const amt of [0, -100, 1.5]) {
        mockSelectSeq([[MANUAL]]);
        const r = await refundPayment("org-1", "pay-1", { amountCents: amt, refundId: "ref-1" });
        expect(r).toEqual({ ok: false, reason: "exceeds_payment" });
      }
      expect(h.refundManualPayment).not.toHaveBeenCalled();
    });

    it("refuses invalid_input without a refundId", async () => {
      mockSelectSeq([[MANUAL]]);
      const r = await refundPayment("org-1", "pay-1", { amountCents: 4000 });
      expect(r).toEqual({ ok: false, reason: "invalid_input" });
      expect(h.refundManualPayment).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  it("rejects a zero or negative refund amount (exceeds_payment) before the provider", async () => {
    const refundSpy = vi.fn();
    const spyProvider = { name: "mock", createCharge: vi.fn(), refund: refundSpy };
    for (const amt of [0, -100]) {
      mockSelectSeq([
        [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, amountRefundedCents: 0, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      ]);
      const r = await refundPayment("org-1", "pay-1", { amountCents: amt }, spyProvider as never);
      expect(r).toEqual({ ok: false, reason: "exceeds_payment" });
    }
    // A non-positive amount must never reach the provider (no real money moves).
    expect(refundSpy).not.toHaveBeenCalled();
  });

  it("rolls back the invoice with an atomic decrement, not a precomputed absolute", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, amountRefundedCents: 0, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [{ amountPaidCents: 10000, totalCents: 10000 }],
    ]);
    const states = captureUpdateStates();
    const r = await refundPayment("org-1", "pay-1", { amountCents: 4000 }, provider);
    expect(r.ok).toBe(true);
    const invSet = states.find((s) => "amountPaidCents" in s);
    expect(invSet).toBeDefined();
    expect(typeof invSet?.amountPaidCents).not.toBe("number");
  });

  it("passes a stable idempotency key to the provider (retry-safe, no double refund)", async () => {
    const refundSpy = vi.fn().mockResolvedValue({ providerRefundId: "r", amountCents: 1000 });
    const spyProvider = { name: "mock", createCharge: vi.fn(), refund: refundSpy };
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, amountRefundedCents: 2000, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [{ amountPaidCents: 10000, totalCents: 10000 }],
    ]);
    captureUpdateStates();
    await refundPayment("org-1", "pay-1", { amountCents: 1000 }, spyProvider as never);
    expect(refundSpy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "pay-1:2000:1000" }),
    );
  });
});

// ---------------------------------------------------------------------------
// Read queries
// ---------------------------------------------------------------------------

/**
 * Sequence db.select results across calls. Each final .where() (or .offset())
 * call is awaitable and returns the next queued result set.
 */
function mockReadSeq(results: unknown[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(
    () => {
      const r = results[i++] ?? [];
      const p = Promise.resolve(r);
      // A chainable thenable: every method returns itself so chains resolve to r.
      const chain: unknown = Object.assign(p, {
        from: () => chain,
        leftJoin: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        groupBy: () => chain,
        limit: () => chain,
        offset: () => chain,
        then: p.then.bind(p),
      });
      return chain as never;
    },
  );
}

describe("listInvoices", () => {
  it("returns the org's invoices in the list shape (org-scoped read)", async () => {
    const rows = [
      {
        id: "inv-1",
        state: "open",
        totalCents: 10000,
        amountPaidCents: 5000,
        customerId: "cust-1",
        serviceRequestId: null,
        createdAt: new Date("2026-01-02"),
        issuedAt: null,
        dueDate: null,
        lastReminderSentAt: null,
        fieldpulseInvoiceId: null,
        hcpInvoiceId: null,
        fieldpulseData: null,
        nameEncrypted: null,
      },
      {
        id: "inv-2",
        state: "paid",
        totalCents: 20000,
        amountPaidCents: 20000,
        customerId: null,
        serviceRequestId: "req-1",
        createdAt: new Date("2026-01-01"),
        issuedAt: null,
        dueDate: null,
        lastReminderSentAt: null,
        fieldpulseInvoiceId: null,
        hcpInvoiceId: null,
        fieldpulseData: null,
        nameEncrypted: null,
      },
    ];
    // listInvoices now makes 3 db.select calls: sourceCounts, count, page rows
    mockReadSeq([[], [{ n: rows.length }], rows]);
    const result = await listInvoices(ORG);
    expect(result.invoices).toHaveLength(2);
    expect(result.invoices[0]).toEqual(
      expect.objectContaining({
        id: "inv-1",
        state: "open",
        totalCents: 10000,
        amountPaidCents: 5000,
      }),
    );
  });
});

describe("getInvoiceDetailById", () => {
  it("returns null when the invoice is not found (or belongs to another org)", async () => {
    mockReadSeq([[]]); // header read -> empty
    const result = await getInvoiceDetailById(ORG, "missing-id");
    expect(result).toBeNull();
  });

  it("nests line items and per-payment refunds", async () => {
    mockReadSeq([
      // 1) invoice header
      [
        {
          id: "inv-1",
          state: "open",
          subtotalCents: 9000,
          taxCents: 1000,
          totalCents: 10000,
          amountPaidCents: 4000,
          customerId: "cust-1",
          serviceRequestId: null,
          estimateId: "est-1",
          createdAt: new Date("2026-01-01"),
        },
      ],
      // 2) line items
      [
        {
          id: "li-1",
          name: "Repair",
          quantity: 1,
          unitPriceCents: 9000,
          lineTotalCents: 9000,
        },
      ],
      // 3) payments
      [
        {
          id: "pay-1",
          amountCents: 4000,
          status: "succeeded",
          isDeposit: true,
          createdAt: new Date("2026-01-01"),
        },
      ],
      // 4) refunds (across the payments)
      [
        {
          id: "ref-1",
          paymentId: "pay-1",
          amountCents: 1000,
          reason: "customer_request",
          createdAt: new Date("2026-01-02"),
        },
      ],
    ]);

    const result = await getInvoiceDetailById(ORG, "inv-1");
    expect(result).not.toBeNull();
    expect(result?.lineItems).toHaveLength(1);
    expect(result?.payments).toHaveLength(1);
    expect(result?.payments[0].refunds).toHaveLength(1);
    expect(result?.payments[0].refunds[0]).toEqual(
      expect.objectContaining({ amountCents: 1000, reason: "customer_request" }),
    );
  });

  const SIGNED = new Date("2026-11-01T15:00:00Z");
  const header = (state: string) => ({
    id: "inv-1", state, subtotalCents: 0, taxCents: 0, totalCents: 0, amountPaidCents: 0,
    customerId: null, serviceRequestId: null, estimateId: null, createdAt: new Date("2026-01-01"),
    signatureUrl: "https://r2/inv.png", signatureName: "Pat Doe", signedAt: SIGNED,
    requestSignatureUrl: "https://r2/req.png", requestSignatureName: "Sam Roe", requestSignedAt: SIGNED,
  });

  it("exposes payment method, check number and provider (spec §3.3)", async () => {
    mockReadSeq([
      [header("open")],
      [],
      [{ id: "pay-1", amountCents: 4000, status: "succeeded", isDeposit: false, createdAt: new Date(), method: "check", checkNumber: "1042", provider: "manual" }],
      [],
    ]);
    const result = await getInvoiceDetailById(ORG, "inv-1");
    expect(result?.payments[0]).toEqual(expect.objectContaining({ method: "check", checkNumber: "1042", provider: "manual" }));
  });

  it("returns the invoice's own signature and no request signature once finalized", async () => {
    mockReadSeq([[header("open")], [], []]);
    const result = await getInvoiceDetailById(ORG, "inv-1");
    expect(result?.signature).toEqual({ url: "https://r2/inv.png", name: "Pat Doe", signedAt: SIGNED });
    expect(result?.requestSignature).toBeNull();
    // the raw joined request columns stay server-side
    expect(result).not.toHaveProperty("requestSignatureUrl");
    expect(result).not.toHaveProperty("signatureUrl");
  });

  it("returns the request's current signature for a draft", async () => {
    mockReadSeq([[header("draft")], [], []]);
    const result = await getInvoiceDetailById(ORG, "inv-1");
    expect(result?.requestSignature).toEqual({ url: "https://r2/req.png", name: "Sam Roe", signedAt: SIGNED });
  });
});

describe("listStuckPayments", () => {
  it("never lists manual or FieldPulse/HCP mirror payments", async () => {
    let whereArg: unknown;
    vi.mocked(db.select).mockReturnValue({
      from: () => ({ where: (w: unknown) => { whereArg = w; return { orderBy: () => Promise.resolve([]) }; } }),
    } as never);
    await listStuckPayments(ORG);
    expect(render(whereArg)).toContain(`"payments"."provider" NOT IN ('manual', 'fieldpulse', 'hcp')`);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation — heal stranded 'pending' payments
// ---------------------------------------------------------------------------

describe("reconcilePayment", () => {
  const PENDING = { id: "pay-1", invoiceId: "inv-1", amountCents: 10000, status: "pending", provider: "mock" };

  /** db.update records set()/where() args; every RETURNING yields `returned`. */
  function captureUpdates(returned: Record<string, unknown>[] = [{ id: "pay-1", state: "paid" }]) {
    const sets: Record<string, unknown>[] = [];
    const wheres: unknown[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            sets.push(v);
            return {
              where: (w: unknown) => {
                wheres.push(w);
                return Object.assign(Promise.resolve(undefined), {
                  returning: vi.fn().mockResolvedValue(returned),
                });
              },
            };
          },
        }) as never,
    );
    return { sets, wheres };
  }

  beforeEach(() => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as never);
    // Earlier describes override db.update (clearAllMocks doesn't reset impls);
    // restore a returning-capable default (CAS claim WON = one row).
    captureUpdates();
  });

  it("completes a stranded 'pending' payment when the provider says succeeded", async () => {
    mockSelectSeq([
      // 1) the stuck payment (still pending)
      [PENDING],
      // 2) the invoice — already credited at claim time (claim-before-charge), so
      //    amountPaidCents ALREADY reflects this payment.
      [{ totalCents: 10000, amountPaidCents: 10000, state: "open" }],
    ]);
    const provider = new MockPaymentProvider(); // getCharge -> succeeded
    const r = await reconcilePayment(ORG, "pay-1", provider);
    expect(r).toEqual({ ok: true, outcome: "completed", invoiceState: "paid" });
    // CAS claim (payment pending->succeeded) + state refresh, NO re-credit.
    expect(db.update).toHaveBeenCalled();
  });

  it("reports the state the SQL actually wrote (a partial deposit stays 'open')", async () => {
    mockSelectSeq([
      [{ ...PENDING, amountCents: 5000 }],
      [{ totalCents: 10000, amountPaidCents: 5000, state: "open" }],
    ]);
    captureUpdates([{ id: "pay-1", state: "open" }]);
    const r = await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    expect(r).toEqual({ ok: true, outcome: "completed", invoiceState: "open" });
  });

  it("writes the succeeded branch's invoice state as a SQL CASE, only over open/paid (spec §5.7)", async () => {
    mockSelectSeq([[PENDING], [{ totalCents: 10000, amountPaidCents: 10000, state: "open" }]]);
    const { sets, wheres } = captureUpdates();
    await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    const i = sets.findIndex((v) => "state" in v);
    expect(typeof sets[i]!.state).not.toBe("string");
    expect(render(sets[i]!.state)).toBe(
      `(CASE WHEN "invoices"."amount_paid_cents" >= "invoices"."total_cents" THEN 'paid' ELSE 'open' END)::invoice_state`,
    );
    expect(render(wheres[i])).toContain(`"invoices"."state" IN ('open'::invoice_state, 'paid'::invoice_state)`);
  });

  it("falls back to the read state when the invoice is no longer open/paid (0 rows)", async () => {
    mockSelectSeq([[PENDING], [{ totalCents: 10000, amountPaidCents: 10000, state: "void" }]]);
    let call = 0;
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: () => ({
            where: () =>
              Object.assign(Promise.resolve(undefined), {
                // CAS claim wins; the guarded invoice update matches nothing.
                returning: vi.fn().mockResolvedValue(call++ === 0 ? [{ id: "pay-1" }] : []),
              }),
          }),
        }) as never,
    );
    const r = await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    expect(r).toEqual({ ok: true, outcome: "completed", invoiceState: "void" });
  });

  it("no-ops (does NOT re-credit) when the CAS claim loses the race to a concurrent reconcile", async () => {
    mockSelectSeq([[PENDING], [{ totalCents: 10000, amountPaidCents: 0, state: "open" }]]);
    // The concurrent winner already flipped the payment: .returning() is empty.
    const { sets } = captureUpdates([]);
    const r = await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    expect(r).toEqual({ ok: true, outcome: "noop" });
    // No invoice update ran (no double-credit, no state write).
    expect(sets.some((v) => "amountPaidCents" in v || "state" in v)).toBe(false);
  });

  it("no-ops (not_pending) when the payment was already succeeded — idempotent", async () => {
    mockSelectSeq([[{ ...PENDING, status: "succeeded" }]]);
    const r = await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    expect(r).toEqual({ ok: false, reason: "not_pending" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  /** The failed branch's ONE batch (spec §5.7), for any provider. */
  function expectFailedBatch(): void {
    expect(db.batch).toHaveBeenCalledTimes(1);
    expect(db.update).not.toHaveBeenCalled();
    const [pay, inv] = batchStmts();
    expect(batchStmts()).toHaveLength(2);
    expect(render(pay)).toBe(
      "UPDATE payments SET status = 'failed'::payment_status, updated_at = now() WHERE id = $1::uuid AND organization_id = $2::uuid AND status = 'pending'::payment_status",
    );
    expect(renderQ(pay).params).toEqual(["pay-1", ORG]);
    expect(render(inv)).toBe(
      "UPDATE invoices SET amount_paid_cents = GREATEST(0, amount_paid_cents - $1::int), " +
        "state = (CASE WHEN state = 'draft'::invoice_state THEN state WHEN GREATEST(0, amount_paid_cents - $2::int) >= total_cents THEN 'paid' ELSE 'open' END)::invoice_state, updated_at = now() " +
        "WHERE id = $3::uuid AND organization_id = $4::uuid AND state IN ('open'::invoice_state, 'paid'::invoice_state, 'draft'::invoice_state) " +
        "AND fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL " +
        "AND EXISTS (SELECT 1 FROM payments WHERE id = $5::uuid AND xmin = pg_current_xact_id()::xid)",
    );
    expect(renderQ(inv).params).toEqual([10000, 10000, "inv-1", ORG, "pay-1"]);
  }

  it("un-credits the invoice in ONE batch when the provider says the charge failed (stripe)", async () => {
    mockSelectSeq([[{ ...PENDING, provider: "stripe" }]]);
    const failingProvider = {
      name: "stripe",
      createCharge: vi.fn(),
      refund: vi.fn(),
      getCharge: vi.fn().mockResolvedValue({ providerPaymentId: "", status: "failed" }),
    };
    const r = await reconcilePayment(ORG, "pay-1", failingProvider as never);
    expect(r).toEqual({ ok: true, outcome: "failed_marked" });
    expectFailedBatch();
  });

  it("fails a pending MOCK payment without asking the provider while cards are disabled", async () => {
    h.cards.on = false;
    mockSelectSeq([[PENDING]]);
    const provider = new MockPaymentProvider();
    const getCharge = vi.spyOn(provider, "getCharge");
    const r = await reconcilePayment(ORG, "pay-1", provider);
    expect(r).toEqual({ ok: true, outcome: "failed_marked" });
    expect(getCharge).not.toHaveBeenCalled();
    expectFailedBatch();
  });

  it("un-claims a DRAFT too and keeps it a draft (ruling: card claims land on drafts)", async () => {
    h.cards.on = false;
    mockSelectSeq([[PENDING]]);
    await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    const inv = render(batchStmts()[1]);
    expect(inv).toContain("CASE WHEN state = 'draft'::invoice_state THEN state WHEN");
    expect(inv).toContain("state IN ('open'::invoice_state, 'paid'::invoice_state, 'draft'::invoice_state)");
  });

  it("still asks the provider for a non-mock payment while cards are disabled", async () => {
    h.cards.on = false;
    mockSelectSeq([[{ ...PENDING, provider: "stripe" }], [{ totalCents: 10000, amountPaidCents: 10000, state: "open" }]]);
    const provider = new MockPaymentProvider();
    const getCharge = vi.spyOn(provider, "getCharge");
    const r = await reconcilePayment(ORG, "pay-1", provider);
    expect(getCharge).toHaveBeenCalledWith("pay-1");
    expect(r).toEqual({ ok: true, outcome: "completed", invoiceState: "paid" });
  });

  it("returns payment_not_found when the payment is missing", async () => {
    mockSelectSeq([[]]);
    const r = await reconcilePayment(ORG, "pay-x", new MockPaymentProvider());
    expect(r).toEqual({ ok: false, reason: "payment_not_found" });
  });

  it("does NOT re-credit the invoice — the money was already credited at claim time (audit CRITICAL)", async () => {
    mockSelectSeq([
      [{ ...PENDING, amountCents: 5000 }],
      // Invoice already reflects the $50 claim credit.
      [{ totalCents: 10000, amountPaidCents: 5000, state: "open" }],
    ]);
    const { sets } = captureUpdates();
    const r = await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    expect(r.ok).toBe(true);
    // No invoice UPDATE may touch amountPaidCents — re-crediting a stranded
    // payment double-counted it (this was the CRITICAL audit finding).
    expect(sets.some((v) => "amountPaidCents" in v)).toBe(false);
    // The invoice update refreshes ONLY the display state.
    expect(sets.some((v) => "state" in v)).toBe(true);
  });
});
