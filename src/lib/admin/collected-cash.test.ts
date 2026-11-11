import { describe, expect, it } from "vitest";
import {
  collectedParts,
  collectedSource,
  collectedTotalCents,
  lastNDaysWindow,
  monthToDateWindow,
  type PaymentFacts,
  type PaymentRow,
  type RefundRow,
} from "./collected-cash";

const FP_INVOICE = { invoiceFieldpulseId: "fp-inv-1", invoiceHcpId: null };
const HCP_INVOICE = { invoiceFieldpulseId: null, invoiceHcpId: "hcp-inv-1" };
const NATIVE_INVOICE = { invoiceFieldpulseId: null, invoiceHcpId: null };

function fpPayment(amountCents: number, paidAt: string, status = "succeeded"): PaymentRow {
  return { fieldpulsePaymentId: `fp-${paidAt}`, status, amountCents, amountRefundedCents: 0, paidAt: new Date(paidAt), ...FP_INVOICE };
}
type InvoiceIds = Pick<PaymentFacts, "invoiceFieldpulseId" | "invoiceHcpId">;
function nativePayment(amountCents: number, paidAt: string, status = "succeeded", inv: InvoiceIds = NATIVE_INVOICE): PaymentRow {
  return { fieldpulsePaymentId: null, status, amountCents, amountRefundedCents: 0, paidAt: new Date(paidAt), ...inv };
}

describe("monthToDateWindow", () => {
  it("starts at New York midnight on the 1st (EDT and EST)", () => {
    expect(monthToDateWindow(new Date("2026-07-15T12:00:00Z")).from.toISOString()).toBe("2026-07-01T04:00:00.000Z");
    expect(monthToDateWindow(new Date("2026-12-15T12:00:00Z")).from.toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });

  it("uses the New York month, not the UTC month, late on the last evening", () => {
    // 2026-12-01T02:00Z is still Nov 30, 9pm in New York.
    expect(monthToDateWindow(new Date("2026-12-01T02:00:00Z")).from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
  });

  it("November spans the DST change: starts on EDT midnight", () => {
    const now = new Date("2026-11-11T21:00:00Z");
    const w = monthToDateWindow(now);
    expect(w.from.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(w.to).toBe(now);
  });
});

describe("lastNDaysWindow", () => {
  it("covers today and the 29 days before it from New York midnight", () => {
    const now = new Date("2026-11-11T21:00:00Z"); // Nov 11, 4pm EST
    // Oct 13 is EDT: midnight = 04:00Z.
    expect(lastNDaysWindow(now, 30).from.toISOString()).toBe("2026-10-13T04:00:00.000Z");
    expect(lastNDaysWindow(now, 1).from.toISOString()).toBe("2026-11-11T05:00:00.000Z");
  });

  it("anchors on the New York date, not the UTC date", () => {
    // 02:00Z on Nov 12 is still Nov 11 in New York.
    expect(lastNDaysWindow(new Date("2026-11-12T02:00:00Z"), 1).from.toISOString()).toBe("2026-11-11T05:00:00.000Z");
  });

  it("treats 0 or fractional days as at least today", () => {
    expect(lastNDaysWindow(new Date("2026-11-11T21:00:00Z"), 0).from.toISOString()).toBe("2026-11-11T05:00:00.000Z");
  });
});

describe("collectedSource (no double count)", () => {
  it("counts a FieldPulse payment once, as FieldPulse, on its FieldPulse invoice", () => {
    expect(collectedSource({ fieldpulsePaymentId: "p1", status: "succeeded", ...FP_INVOICE })).toBe("fieldpulse");
  });

  it("never counts a FieldPulse payment that is not settled", () => {
    for (const status of ["refunded", "pending", "failed"]) {
      expect(collectedSource({ fieldpulsePaymentId: "p1", status, ...FP_INVOICE })).toBeNull();
    }
  });

  it("never counts a FieldPulse payment linked to a native invoice", () => {
    expect(collectedSource({ fieldpulsePaymentId: "p1", status: "succeeded", ...NATIVE_INVOICE })).toBeNull();
  });

  it("never counts a native payment on a FieldPulse or Housecall Pro invoice", () => {
    expect(collectedSource({ fieldpulsePaymentId: null, status: "succeeded", ...FP_INVOICE })).toBeNull();
    expect(collectedSource({ fieldpulsePaymentId: null, status: "succeeded", ...HCP_INVOICE })).toBeNull();
  });

  it("counts native payments on native invoices, fully refunded ones too", () => {
    expect(collectedSource({ fieldpulsePaymentId: null, status: "succeeded", ...NATIVE_INVOICE })).toBe("native");
    expect(collectedSource({ fieldpulsePaymentId: null, status: "refunded", ...NATIVE_INVOICE })).toBe("native");
    expect(collectedSource({ fieldpulsePaymentId: null, status: "pending", ...NATIVE_INVOICE })).toBeNull();
  });
});

describe("collectedParts", () => {
  const november = monthToDateWindow(new Date("2026-11-11T21:00:00Z"));

  it("sums FieldPulse and native money by payment date, less native refunds", () => {
    const rows = [
      fpPayment(120_000, "2026-11-03T15:00:00Z"),
      fpPayment(30_000, "2026-11-10T15:00:00Z"),
      nativePayment(20_000, "2026-11-05T15:00:00Z"),
      nativePayment(10_000, "2026-11-06T15:00:00Z", "refunded"),
    ];
    const refunds: RefundRow[] = [
      { amountCents: 10_000, refundedAt: new Date("2026-11-07T15:00:00Z"), payment: { fieldpulsePaymentId: null, status: "refunded", ...NATIVE_INVOICE } },
    ];
    const parts = collectedParts(rows, refunds, november);
    expect(parts).toEqual({ fieldpulseCents: 150_000, nativeReceivedCents: 30_000, nativeRefundedCents: 10_000 });
    expect(collectedTotalCents(parts)).toBe(170_000);
  });

  it("puts a payment in the month of its New York date", () => {
    // 03:30Z on Nov 1 is 11:30pm Oct 31 in New York: October money.
    const rows = [fpPayment(50_000, "2026-11-01T03:30:00Z"), fpPayment(7_000, "2026-11-01T04:00:00Z")];
    expect(collectedParts(rows, [], november).fieldpulseCents).toBe(7_000);
  });

  it("excludes payments after the window end", () => {
    const rows = [nativePayment(5_000, "2026-11-11T21:00:01Z")];
    expect(collectedParts(rows, [], november).nativeReceivedCents).toBe(0);
  });

  it("does not double count when the same invoice shows up through both paths", () => {
    // A native payment wrongly written on the FieldPulse invoice (the write
    // paths refuse this) must not add to that invoice's FieldPulse payment.
    const rows = [fpPayment(40_000, "2026-11-04T15:00:00Z"), nativePayment(40_000, "2026-11-04T15:00:00Z", "succeeded", FP_INVOICE)];
    expect(collectedTotalCents(collectedParts(rows, [], november))).toBe(40_000);
  });

  it("subtracts refunds only from money it counted", () => {
    const refunds: RefundRow[] = [
      { amountCents: 9_000, refundedAt: new Date("2026-11-04T15:00:00Z"), payment: { fieldpulsePaymentId: "p1", status: "succeeded", ...FP_INVOICE } },
    ];
    expect(collectedParts([], refunds, november).nativeRefundedCents).toBe(0);
  });

  it("subtracts amount_refunded_cents on a settled FieldPulse payment", () => {
    const row = { ...fpPayment(10_000, "2026-11-04T15:00:00Z"), amountRefundedCents: 2_500 };
    expect(collectedParts([row], [], november).fieldpulseCents).toBe(7_500);
  });
});
