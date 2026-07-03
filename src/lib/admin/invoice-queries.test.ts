import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  takePayment,
  listInvoices,
  getInvoiceDetailById,
  reconcilePayment,
} from "./invoice-queries";
import { db } from "@/lib/db";
import { MockPaymentProvider } from "@/lib/payments/provider";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
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

beforeEach(() => vi.clearAllMocks());

describe("takePayment", () => {
  const provider = new MockPaymentProvider();

  it("marks the invoice paid when fully covered", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const r = await takePayment(ORG, "inv-1", { amountCents: 10000 }, provider);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invoiceState).toBe("paid");
    expect(db.batch).toHaveBeenCalledTimes(1); // payment + invoice update batched
  });

  it("keeps the invoice open on a partial deposit", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const r = await takePayment(ORG, "inv-1", { amountCents: 5000, isDeposit: true }, provider);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invoiceState).toBe("open");
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
            return Object.assign(p, { limit: () => Promise.resolve(r) });
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
    expect(r).toEqual({ ok: true, invoiceId: "inv-existing" });
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

  it("creates an invoice (state 'open') from the sold option's snapshot on first call", async () => {
    mockCreateSeq([
      [{ id: "est-1", status: "sold", soldOptionId: "opt-1", customerId: "c", serviceRequestId: "r" }],
      [], // no existing invoice yet
      [{ subtotalCents: 9000, taxCents: 1000, totalCents: 10000 }], // option totals
      [{ name: "Repair", quantity: 1, unitPriceCents: 9000, costCents: 4000, lineTotalCents: 9000 }],
    ]);
    const r = await createInvoiceFromSoldEstimate(ORG, "est-1");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.invoiceId).toBeTruthy();
    // invoice insert + line-items insert batched atomically.
    expect(db.batch).toHaveBeenCalledTimes(1);
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

    // 3) takePayment(full): open -> paid.
    mockCreateSeq([[{ id: "inv-1", state: "open", totalCents: 10000, amountPaidCents: 0 }]]);
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
    expect(states.find((s) => "state" in s)?.state).toBe("paid");
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

  it("keeps a fully-paid invoice 'paid' (NOT chargeable) after a PARTIAL refund — guards over-collection", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, amountRefundedCents: 0, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [{ amountPaidCents: 10000, totalCents: 10000 }], // invoice was FULLY paid
    ]);
    const states = captureUpdateStates();
    const r = await refundPayment("org-1", "pay-1", { amountCents: 4000 }, provider);
    expect(r.ok).toBe(true);
    const invoiceSet = states.find((s) => "state" in s);
    expect(invoiceSet?.state).toBe("paid"); // pre-fix this regressed to "open"
  });

  it("reopens a partially-paid invoice ('open') after a partial refund — a real balance remains", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 5000, amountRefundedCents: 0, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [{ amountPaidCents: 5000, totalCents: 10000 }], // only partially paid
    ]);
    const states = captureUpdateStates();
    await refundPayment("org-1", "pay-1", { amountCents: 2000 }, provider);
    expect(states.find((s) => "state" in s)?.state).toBe("open");
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
 * Sequence db.select results across calls. Each where() result is awaitable AND
 * supports .limit() (header reads) and .orderBy() (list reads) — both resolve to
 * the same row set for that call.
 */
function mockReadSeq(results: unknown[][]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({
          where: () => {
            const r = results[i++] ?? [];
            const p = Promise.resolve(r);
            return Object.assign(p, {
              limit: () => Promise.resolve(r),
              orderBy: () => Promise.resolve(r),
            });
          },
        }),
      }) as never,
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
      },
      {
        id: "inv-2",
        state: "paid",
        totalCents: 20000,
        amountPaidCents: 20000,
        customerId: null,
        serviceRequestId: "req-1",
        createdAt: new Date("2026-01-01"),
      },
    ];
    mockReadSeq([rows]);
    const result = await listInvoices(ORG);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(
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
});

// ---------------------------------------------------------------------------
// Reconciliation — heal stranded 'pending' payments
// ---------------------------------------------------------------------------

describe("reconcilePayment", () => {
  beforeEach(() => {
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    } as never);
    // Earlier describes override db.update (clearAllMocks doesn't reset impls);
    // restore a returning-capable default (CAS claim WON = one row) so the
    // reconcile success paths work. The lost-race test overrides this locally.
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: vi.fn(() => ({
            where: vi.fn(() =>
              Object.assign(Promise.resolve(undefined), {
                returning: vi.fn().mockResolvedValue([{ id: "pay-1" }]),
              }),
            ),
          })),
        }) as never,
    );
  });

  it("completes a stranded 'pending' payment when the provider says succeeded", async () => {
    mockSelectSeq([
      // 1) the stuck payment (still pending)
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, status: "pending" }],
      // 2) the invoice — already credited at claim time (claim-before-charge), so
      //    amountPaidCents ALREADY reflects this payment.
      [{ totalCents: 10000, amountPaidCents: 10000 }],
    ]);
    const provider = new MockPaymentProvider(); // getCharge -> succeeded
    const r = await reconcilePayment(ORG, "pay-1", provider);
    expect(r).toEqual({ ok: true, outcome: "completed", invoiceState: "paid" });
    // CAS claim (payment pending->succeeded) + state refresh, NO re-credit.
    expect(db.update).toHaveBeenCalled();
  });

  it("leaves the invoice 'open' when a partial deposit is reconciled", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 5000, status: "pending" }],
      // Only the $50 deposit was credited (at claim time) against a $100 invoice.
      [{ totalCents: 10000, amountPaidCents: 5000 }],
    ]);
    const r = await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    expect(r).toEqual({ ok: true, outcome: "completed", invoiceState: "open" });
  });

  it("no-ops (does NOT re-credit) when the CAS claim loses the race to a concurrent reconcile", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, status: "pending" }],
      [{ totalCents: 10000, amountPaidCents: 0 }],
    ]);
    // Simulate the concurrent winner: the CAS update matches 0 rows (already
    // flipped to succeeded by the other reconcile), so .returning() is empty.
    const invoiceSets: Record<string, unknown>[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            invoiceSets.push(v);
            return {
              where: () =>
                Object.assign(Promise.resolve(undefined), {
                  returning: vi.fn().mockResolvedValue([]), // 0 rows -> lost
                }),
            };
          },
        }) as never,
    );
    const r = await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    expect(r).toEqual({ ok: true, outcome: "noop" });
    // The invoice amountPaidCents update must NOT have run (no double-credit).
    expect(invoiceSets.some((s) => "amountPaidCents" in s)).toBe(false);
  });

  it("no-ops (not_pending) when the payment was already succeeded — idempotent", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, status: "succeeded" }],
    ]);
    const r = await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    expect(r).toEqual({ ok: false, reason: "not_pending" });
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("un-credits the invoice when the provider says the charge failed (claim-before-charge)", async () => {
    // The invoice was credited at claim time; a definitively-failed charge must
    // decrement it back (else the invoice stays over-credited forever).
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, status: "pending" }],
      [{ totalCents: 10000, amountPaidCents: 10000 }], // invoice (reconcile reads it before the CAS)
    ]);
    const sets: Record<string, unknown>[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            sets.push(v);
            return {
              where: () =>
                Object.assign(Promise.resolve(undefined), {
                  returning: vi.fn().mockResolvedValue([{ id: "pay-1" }]),
                }),
            };
          },
        }) as never,
    );
    const failingProvider = {
      name: "mock",
      createCharge: vi.fn(),
      refund: vi.fn(),
      getCharge: vi
        .fn()
        .mockResolvedValue({ providerPaymentId: "", status: "failed" }),
    };
    const r = await reconcilePayment(ORG, "pay-1", failingProvider as never);
    expect(r).toEqual({ ok: true, outcome: "failed_marked" });
    // payment flipped to failed + invoice decremented (a SQL expression).
    expect(sets.some((s) => s.status === "failed")).toBe(true);
    const decrement = sets.find((s) => "amountPaidCents" in s);
    expect(decrement).toBeDefined();
    expect(typeof decrement?.amountPaidCents).not.toBe("number");
  });

  it("returns payment_not_found when the payment is missing", async () => {
    mockSelectSeq([[]]);
    const r = await reconcilePayment(ORG, "pay-x", new MockPaymentProvider());
    expect(r).toEqual({ ok: false, reason: "payment_not_found" });
  });

  // The payment-status CAS stops a SECOND reconcile of the SAME payment, but two
  // reconciles of DIFFERENT pending payments on the same invoice would still
  // lost-update an absolute write. So the credit must be an atomic SQL increment.
  it("does NOT re-credit the invoice — the money was already credited at claim time (audit CRITICAL)", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 5000, status: "pending" }],
      // Invoice already reflects the $50 claim credit.
      [{ totalCents: 10000, amountPaidCents: 5000 }],
    ]);
    const sets: Record<string, unknown>[] = [];
    vi.mocked(db.update).mockImplementation(
      () =>
        ({
          set: (v: Record<string, unknown>) => {
            sets.push(v);
            return {
              where: () =>
                Object.assign(Promise.resolve(undefined), {
                  returning: vi.fn().mockResolvedValue([{ id: "pay-1" }]),
                }),
            };
          },
        }) as never,
    );
    const r = await reconcilePayment(ORG, "pay-1", new MockPaymentProvider());
    expect(r.ok).toBe(true);
    // No invoice UPDATE may touch amountPaidCents — re-crediting a stranded
    // payment double-counted it (this was the CRITICAL audit finding).
    expect(sets.some((s) => "amountPaidCents" in s)).toBe(false);
    // The invoice update refreshes ONLY the display state.
    expect(sets.some((s) => "state" in s)).toBe(true);
  });
});
