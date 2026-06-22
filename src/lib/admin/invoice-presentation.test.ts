import { describe, it, expect } from "vitest";
import {
  deriveInvoicePresentation,
  type InvoicePresentationInput,
} from "./invoice-presentation";

function inv(over: Partial<InvoicePresentationInput> = {}): InvoicePresentationInput {
  return {
    state: "open",
    totalCents: 10000,
    amountPaidCents: 0,
    syncedSource: null,
    ...over,
  };
}

describe("deriveInvoicePresentation", () => {
  it("computes the outstanding balance", () => {
    expect(deriveInvoicePresentation(inv({ totalCents: 10000, amountPaidCents: 4000 })).balanceCents).toBe(6000);
  });

  it("a native open invoice with a balance is chargeable and can take payment", () => {
    const p = deriveInvoicePresentation(inv({ state: "open", amountPaidCents: 0 }));
    expect(p.isChargeable).toBe(true);
    expect(p.canTakePayment).toBe(true);
    expect(p.isSynced).toBe(false);
    expect(p.sourceLabel).toBeNull();
  });

  it("a native draft invoice with a balance is chargeable", () => {
    expect(deriveInvoicePresentation(inv({ state: "draft" })).canTakePayment).toBe(true);
  });

  it("a fully-paid invoice is NOT chargeable (zero balance)", () => {
    const p = deriveInvoicePresentation(inv({ totalCents: 10000, amountPaidCents: 10000 }));
    expect(p.isChargeable).toBe(false);
    expect(p.canTakePayment).toBe(false);
  });

  it("a paid/void/refunded state is NOT chargeable even with a balance", () => {
    for (const state of ["paid", "void", "refunded"]) {
      expect(deriveInvoicePresentation(inv({ state })).canTakePayment).toBe(false);
    }
  });

  // THE money-safety affordance: a synced (read-only) invoice must NEVER expose
  // the native take-payment control, even when its state+balance look chargeable.
  it("a FieldPulse-synced invoice can NEVER take native payment (even when open with a balance)", () => {
    const p = deriveInvoicePresentation(
      inv({ state: "open", amountPaidCents: 0, syncedSource: "fieldpulse" }),
    );
    expect(p.isSynced).toBe(true);
    expect(p.sourceLabel).toBe("FieldPulse");
    expect(p.isChargeable).toBe(true); // state/balance alone would allow it...
    expect(p.canTakePayment).toBe(false); // ...but the read-only guard wins.
  });

  it("a Housecall-synced invoice maps its label and blocks native payment", () => {
    const p = deriveInvoicePresentation(inv({ syncedSource: "housecall" }));
    expect(p.sourceLabel).toBe("Housecall Pro");
    expect(p.canTakePayment).toBe(false);
  });
});
