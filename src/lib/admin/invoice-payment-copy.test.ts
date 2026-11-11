import { describe, it, expect } from "vitest";
import {
  paymentChipLabel,
  paymentWhenLabel,
  canOfferFinancing,
  RECORD_PAYMENT_METHODS,
  RECORD_PAYMENT_NETWORK_COPY,
  REFUND_NETWORK_COPY,
  buildRecordPaymentBody,
  canRecordPayment,
  refundErrorCopy,
  finalizeErrorCopy,
  paymentMethodLabel,
  paymentMethodSummary,
  recordPaymentErrorCopy,
  refundSuccessCopy,
  shouldReloadAfterRecord,
  shouldRemintToken,
  CARD_PAYMENTS_OFF_COPY,
  canSendReminder,
  centsToInputDollars,
  invoiceLinkAction,
  overBalanceCopy,
  paymentStatusLabel,
  receiptNoticeCopy,
  refundReasonLabel,
} from "./invoice-payment-copy";

const TOKEN = "6f1c6b3e-2a7d-4f0e-9c1d-3b8e5a2f7d41";

describe("RECORD_PAYMENT_METHODS", () => {
  it("offers Cash / Check / Other and never Card", () => {
    expect(RECORD_PAYMENT_METHODS.map((m) => m.label)).toEqual(["Cash", "Check", "Other"]);
    expect(RECORD_PAYMENT_METHODS.some((m) => (m.value as string) === "card")).toBe(false);
  });
});

describe("recordPaymentErrorCopy", () => {
  it("maps the known codes to human copy", () => {
    expect(recordPaymentErrorCopy("EXCEEDS_BALANCE")).toBe("That's more than the balance due.");
    expect(recordPaymentErrorCopy("INVOICE_NOT_CHARGEABLE")).toBe("Finalize the invoice first.");
    expect(recordPaymentErrorCopy("ID_CONFLICT")).toBe(
      "This payment may already be recorded. Check the payments list before recording it again.",
    );
    expect(recordPaymentErrorCopy("STALE")).toBe("This invoice changed. Refresh and try again.");
    expect(recordPaymentErrorCopy("INVOICE_SYNCED_READ_ONLY")).toBe("This invoice is managed in FieldPulse.");
  });

  it("falls back to generic copy for anything else, never the raw code", () => {
    for (const code of [undefined, "INTERNAL_ERROR", "VALIDATION_ERROR", "SOMETHING_NEW"]) {
      expect(recordPaymentErrorCopy(code)).toBe("Couldn't record the payment. Please try again.");
    }
  });
});

describe("uncertain record outcomes", () => {
  it("reloads after a network error (null code) or an ID_CONFLICT only", () => {
    expect(shouldReloadAfterRecord(null)).toBe(true);
    expect(shouldReloadAfterRecord("ID_CONFLICT")).toBe(true);
    expect(shouldReloadAfterRecord(undefined)).toBe(false);
    expect(shouldReloadAfterRecord("EXCEEDS_BALANCE")).toBe(false);
    expect(shouldReloadAfterRecord("STALE")).toBe(false);
  });

  it("network copy says the money may have landed and never says token", () => {
    expect(RECORD_PAYMENT_NETWORK_COPY).toBe(
      "Couldn't reach the server. The payment may have been recorded. Check the list before trying again.",
    );
    expect(REFUND_NETWORK_COPY).toBe(
      "Couldn't reach the server. The refund may have been recorded. Check the list before trying again.",
    );
    expect(recordPaymentErrorCopy("ID_CONFLICT")).not.toMatch(/token/i);
  });
});

describe("finalizeErrorCopy", () => {
  it("maps the finalize refusals", () => {
    expect(finalizeErrorCopy("NO_LINES")).toBe("Add at least one item first.");
    expect(finalizeErrorCopy("INVOICE_LOCKED")).toBe("This invoice is already finalized.");
    expect(finalizeErrorCopy("STALE")).toBe("This invoice changed. Refresh and try again.");
    expect(finalizeErrorCopy(undefined)).toBe("Couldn't finalize the invoice. Please try again.");
  });
});

describe("shouldRemintToken", () => {
  it("replaces the token after a success or an ID_CONFLICT only", () => {
    expect(shouldRemintToken(true, undefined)).toBe(true);
    expect(shouldRemintToken(false, "ID_CONFLICT")).toBe(true);
    expect(shouldRemintToken(false, "EXCEEDS_BALANCE")).toBe(false);
    expect(shouldRemintToken(false, undefined)).toBe(false);
  });
});

describe("paymentMethodLabel / paymentMethodSummary", () => {
  it("labels each method", () => {
    expect(paymentMethodLabel("card")).toBe("Card");
    expect(paymentMethodLabel("cash")).toBe("Cash");
    expect(paymentMethodLabel("check")).toBe("Check");
    expect(paymentMethodLabel("other")).toBe("Other");
    expect(paymentMethodLabel("weird")).toBe("Other");
  });

  it("appends the check number when present", () => {
    expect(paymentMethodSummary("check", "1042")).toBe("Check · #1042");
    expect(paymentMethodSummary("check", null)).toBe("Check");
    expect(paymentMethodSummary("cash", null)).toBe("Cash");
  });
});

describe("refundSuccessCopy", () => {
  it("tells the office to return manual money themselves", () => {
    expect(refundSuccessCopy("manual")).toBe("Refund recorded. Return the money to the customer yourself.");
  });

  it("has no extra copy for provider refunds", () => {
    expect(refundSuccessCopy("mock")).toBeNull();
    expect(refundSuccessCopy("stripe")).toBeNull();
  });
});

describe("buildRecordPaymentBody", () => {
  it("sends the trimmed check number only for a check", () => {
    expect(
      buildRecordPaymentBody({ clientToken: TOKEN, method: "check", amountCents: 500, checkNumber: " 1042 ", isDeposit: false }),
    ).toEqual({ clientToken: TOKEN, method: "check", amountCents: 500, checkNumber: "1042", isDeposit: false });
  });

  it("omits a blank check number", () => {
    expect(
      buildRecordPaymentBody({ clientToken: TOKEN, method: "check", amountCents: 500, checkNumber: "  ", isDeposit: true }),
    ).toEqual({ clientToken: TOKEN, method: "check", amountCents: 500, isDeposit: true });
  });

  it("drops a leftover check number when the method is not check", () => {
    expect(
      buildRecordPaymentBody({ clientToken: TOKEN, method: "cash", amountCents: 500, checkNumber: "1042", isDeposit: false }),
    ).toEqual({ clientToken: TOKEN, method: "cash", amountCents: 500, isDeposit: false });
  });
});

describe("canRecordPayment", () => {
  it("allows a hand-recorded payment only on an open, chargeable invoice", () => {
    expect(canRecordPayment({ state: "open", canTakePayment: true })).toBe(true);
    expect(canRecordPayment({ state: "draft", canTakePayment: true })).toBe(false);
    expect(canRecordPayment({ state: "paid", canTakePayment: false })).toBe(false);
    expect(canRecordPayment({ state: "paid", canTakePayment: true })).toBe(false);
    expect(canRecordPayment({ state: "open", canTakePayment: false })).toBe(false);
  });
});

describe("refundErrorCopy", () => {
  it("maps the refund route codes to human copy", () => {
    expect(refundErrorCopy("ID_CONFLICT")).toBe("That refund token was already used. Try again.");
    expect(refundErrorCopy("EXCEEDS_PAYMENT")).toBe("That's more than is left to refund on this payment.");
    expect(refundErrorCopy("NOT_REFUNDABLE")).toBe("This payment can't be refunded.");
    expect(refundErrorCopy("STALE")).toBe("This payment changed. Refresh and try again.");
    expect(refundErrorCopy("INVOICE_SYNCED_READ_ONLY")).toBe("This invoice is managed in FieldPulse.");
  });

  it("falls back to generic copy", () => {
    for (const code of [undefined, "INTERNAL_ERROR", "NOPE"]) {
      expect(refundErrorCopy(code)).toBe("Couldn't record the refund. Please try again.");
    }
  });
});

describe("card-off + customer link helpers", () => {
  const base = { state: "open", syncedSource: null, customerId: "c1", cardPaymentsEnabled: false };

  it("labels the link for what it is while cards are off", () => {
    expect(invoiceLinkAction(base)).toEqual({ label: "Copy portal link" });
    expect(invoiceLinkAction({ ...base, cardPaymentsEnabled: true })).toEqual({ label: "Copy pay link" });
  });

  it("offers no link on drafts, settled, synced or customer-less invoices", () => {
    expect(invoiceLinkAction({ ...base, state: "draft" })).toBeNull();
    expect(invoiceLinkAction({ ...base, state: "paid" })).toBeNull();
    expect(invoiceLinkAction({ ...base, state: "void" })).toBeNull();
    expect(invoiceLinkAction({ ...base, syncedSource: "fieldpulse" })).toBeNull();
    expect(invoiceLinkAction({ ...base, customerId: null })).toBeNull();
  });

  it("states plainly that card payments are off", () => {
    expect(CARD_PAYMENTS_OFF_COPY).toMatch(/Card payments aren't set up yet/);
  });

  it("only offers a reminder when there is a customer to text", () => {
    expect(canSendReminder({ collectible: true, syncedSource: null, customerId: "c1" })).toBe(true);
    expect(canSendReminder({ collectible: true, syncedSource: null, customerId: null })).toBe(false);
    expect(canSendReminder({ collectible: true, syncedSource: "housecall", customerId: "c1" })).toBe(false);
    expect(canSendReminder({ collectible: false, syncedSource: null, customerId: "c1" })).toBe(false);
  });

  it("warns about the receipt text only when one can go out", () => {
    expect(receiptNoticeCopy({ customerId: "c1", customerPhone: "(423) 555-0100" })).toMatch(/text the customer a receipt/);
    expect(receiptNoticeCopy({ customerId: "c1", customerPhone: null })).toBeNull();
    expect(receiptNoticeCopy({ customerId: null, customerPhone: null })).toBeNull();
  });
});

describe("record-payment amount helpers", () => {
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  it("names the balance when the amount is over it", () => {
    expect(overBalanceCopy(30000, 29895, fmt)).toBe("That's more than the balance due ($298.95).");
    expect(overBalanceCopy(29895, 29895, fmt)).toBeNull();
  });
  it("pre-fills the balance as dollars", () => {
    expect(centsToInputDollars(29895)).toBe("298.95");
    expect(centsToInputDollars(0)).toBe("");
  });
});

describe("payment row labels", () => {
  it("never shows the raw status enum", () => {
    expect(paymentStatusLabel("succeeded", 0)).toBe("Received");
    expect(paymentStatusLabel("succeeded", 5000)).toBe("Partly refunded");
    expect(paymentStatusLabel("refunded", 20000)).toBe("Refunded");
    expect(paymentStatusLabel("pending", 0)).toBe("Pending");
    expect(paymentStatusLabel("weird", 0)).toBe("Unknown");
  });
  it("maps refund reason codes to the picker labels", () => {
    expect(refundReasonLabel("defective")).toBe("Defective / service issue");
    expect(refundReasonLabel("customer_request")).toBe("Customer request");
    expect(refundReasonLabel(null)).toBeNull();
    expect(refundReasonLabel("nope")).toBeNull();
  });
});

describe("canOfferFinancing", () => {
  it("is offered only with a customer to send the link to and an amount", () => {
    expect(canOfferFinancing({ customerId: "c1", amountCents: 1000 })).toBe(true);
    expect(canOfferFinancing({ customerId: null, amountCents: 1000 })).toBe(false);
    expect(canOfferFinancing({ customerId: "c1", amountCents: 0 })).toBe(false);
  });
});

describe("paymentChipLabel", () => {
  it("a FieldPulse mirror names FieldPulse instead of Other", () => {
    expect(paymentChipLabel({ method: "other", checkNumber: null, provider: "fieldpulse" })).toBe("In FieldPulse");
  });
  it("our payments keep the method summary", () => {
    expect(paymentChipLabel({ method: "check", checkNumber: "1042", provider: "manual" })).toBe("Check · #1042");
  });
});

describe("paymentWhenLabel", () => {
  const NOON_UTC = new Date("2024-12-20T12:00:00Z");
  it("a FieldPulse payment shows its day only, never a made-up time", () => {
    expect(paymentWhenLabel(NOON_UTC, "fieldpulse", "America/New_York")).toBe("Dec 20, 2024");
  });
  it("our payments show the moment in the business time zone", () => {
    expect(paymentWhenLabel(new Date("2026-11-06T03:26:00Z"), "manual", "America/New_York")).toBe("Nov 5, 2026, 10:26 PM");
  });
});
