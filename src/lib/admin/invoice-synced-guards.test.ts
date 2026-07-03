/**
 * Money-safety: the native payment flows MUST refuse a Fieldpulse-synced invoice
 * (fieldpulseInvoiceId != null). Fieldpulse holds the real money for those rows;
 * taking/refunding/reconciling natively would double-charge or double-credit.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { takePayment, refundPayment, reconcilePayment } from "./invoice-queries";
import { db } from "@/lib/db";
import { MockPaymentProvider } from "@/lib/payments/provider";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), batch: vi.fn() },
}));

const mockedSelect = db.select as unknown as ReturnType<typeof vi.fn>;
const ORG = "org-1";

/** A `.from().where().limit()`-shaped result. */
function limitChain(rows: unknown[]) {
  return {
    from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
  };
}
beforeEach(() => vi.clearAllMocks());

describe("synced-invoice money guards", () => {
  it("takePayment refuses a synced invoice and never charges", async () => {
    const provider = new MockPaymentProvider();
    const charge = vi.spyOn(provider, "createCharge");
    mockedSelect.mockReturnValueOnce(
      limitChain([
        { id: "inv-1", state: "open", totalCents: 10000, amountPaidCents: 0, fieldpulseInvoiceId: "fp-1" },
      ]) as never,
    );
    const r = await takePayment(ORG, "inv-1", { amountCents: 5000 }, provider);
    expect(r).toEqual({ ok: false, reason: "synced_read_only" });
    expect(charge).not.toHaveBeenCalled();
  });

  it("takePayment refuses a Housecall-Pro-synced invoice too", async () => {
    const provider = new MockPaymentProvider();
    const charge = vi.spyOn(provider, "createCharge");
    mockedSelect.mockReturnValueOnce(
      limitChain([
        { id: "inv-1", state: "open", totalCents: 10000, amountPaidCents: 0, fieldpulseInvoiceId: null, hcpInvoiceId: "hcp-1" },
      ]) as never,
    );
    const r = await takePayment(ORG, "inv-1", { amountCents: 5000 }, provider);
    expect(r).toEqual({ ok: false, reason: "synced_read_only" });
    expect(charge).not.toHaveBeenCalled();
  });

  it("refundPayment refuses a synced invoice and never refunds", async () => {
    const provider = new MockPaymentProvider();
    const refund = vi.spyOn(provider, "refund");
    mockedSelect
      // 1: the payment (the running refunded total now lives on the row, not a
      // separate SUM(refunds) select)
      .mockReturnValueOnce(
        limitChain([
          { id: "pay-1", invoiceId: "inv-1", amountCents: 5000, amountRefundedCents: 0, status: "succeeded", providerPaymentId: "ch_1" },
        ]) as never,
      )
      // 2: the invoice — synced
      .mockReturnValueOnce(
        limitChain([{ amountPaidCents: 5000, totalCents: 10000, fieldpulseInvoiceId: "fp-1" }]) as never,
      );
    const r = await refundPayment(ORG, "pay-1", { amountCents: 5000 }, provider);
    expect(r).toEqual({ ok: false, reason: "synced_read_only" });
    expect(refund).not.toHaveBeenCalled();
  });

  it("reconcilePayment refuses a synced invoice (no double-credit)", async () => {
    const provider = new MockPaymentProvider();
    vi.spyOn(provider, "getCharge").mockResolvedValue({
      status: "succeeded",
      providerPaymentId: "ch_1",
    });
    mockedSelect
      // 1: the pending payment
      .mockReturnValueOnce(
        limitChain([
          { id: "pay-1", invoiceId: "inv-1", amountCents: 5000, status: "pending" },
        ]) as never,
      )
      // 2: the invoice — synced
      .mockReturnValueOnce(
        limitChain([{ totalCents: 10000, amountPaidCents: 0, fieldpulseInvoiceId: "fp-1" }]) as never,
      );
    const r = await reconcilePayment(ORG, "pay-1", provider);
    expect(r).toEqual({ ok: false, reason: "synced_read_only" });
  });
});
