import { describe, it, expect } from "vitest";
import {
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
