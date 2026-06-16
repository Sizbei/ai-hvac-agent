import { describe, it, expect, beforeEach, vi } from "vitest";
import { takePayment } from "./invoice-queries";
import { db } from "@/lib/db";
import { MockPaymentProvider } from "@/lib/payments/provider";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    batch: vi.fn().mockResolvedValue([]),
    // update() is used to BUILD statements (passed to batch) and directly in the
    // charge-failed path; return a chainable that resolves harmlessly.
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) })),
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

  it("reports charge_failed when the provider declines (amount <= 0)", async () => {
    mockInvoice({ totalCents: 10000, amountPaidCents: 0 });
    const r = await takePayment(ORG, "inv-1", { amountCents: 0 }, provider);
    expect(r).toEqual({ ok: false, reason: "charge_failed" });
  });
});

import { refundPayment } from "./invoice-queries";

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
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [], // no prior refunds
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

  it("blocks over-refunding beyond the remaining balance", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [{ amountCents: 7000 }], // already refunded 7000 -> only 3000 left
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
            return { where: vi.fn().mockResolvedValue(undefined) };
          },
        }) as never,
    );
    return states;
  }

  it("keeps a fully-paid invoice 'paid' (NOT chargeable) after a PARTIAL refund — guards over-collection", async () => {
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [], // no prior refunds
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
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 5000, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [],
      [{ amountPaidCents: 5000, totalCents: 10000 }], // only partially paid
    ]);
    const states = captureUpdateStates();
    await refundPayment("org-1", "pay-1", { amountCents: 2000 }, provider);
    expect(states.find((s) => "state" in s)?.state).toBe("open");
  });

  it("passes a stable idempotency key to the provider (retry-safe, no double refund)", async () => {
    const refundSpy = vi.fn().mockResolvedValue({ providerRefundId: "r", amountCents: 1000 });
    const spyProvider = { name: "mock", createCharge: vi.fn(), refund: refundSpy };
    mockSelectSeq([
      [{ id: "pay-1", invoiceId: "inv-1", amountCents: 10000, status: "succeeded", providerPaymentId: "mock_pay_x" }],
      [{ amountCents: 2000 }], // 2000 already refunded
      [{ amountPaidCents: 10000, totalCents: 10000 }],
    ]);
    captureUpdateStates();
    await refundPayment("org-1", "pay-1", { amountCents: 1000 }, spyProvider as never);
    expect(refundSpy).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "pay-1:2000:1000" }),
    );
  });
});
