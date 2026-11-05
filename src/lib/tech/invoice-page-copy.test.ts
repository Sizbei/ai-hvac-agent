import { describe, it, expect } from "vitest";
import {
  invoiceChipLabel,
  materialsPrompt,
  newInvoicePrompt,
  paymentLabel,
  paymentStatusLabel,
  signatureCopy,
  taxLabel,
  totalsFooter,
  writeErrorCopy,
} from "./invoice-page-copy";

describe("invoiceChipLabel", () => {
  it("labels each state", () => {
    expect(invoiceChipLabel(null)).toBe("No invoice yet");
    expect(invoiceChipLabel({ state: "draft", balanceCents: 0 })).toBe("Draft");
    expect(invoiceChipLabel({ state: "open", balanceCents: 12345 })).toBe("Open · $123.45 due");
    expect(invoiceChipLabel({ state: "paid", balanceCents: 0 })).toBe("Paid");
    expect(invoiceChipLabel({ state: "refunded", balanceCents: 0 })).toBe("Refunded");
  });
});

describe("writeErrorCopy", () => {
  const err = (code: string, message = "Server says no.", details?: object) => ({
    success: false as const, error: { code, message, details },
  });

  it("is silent on success and on a dropped intent", () => {
    expect(writeErrorCopy("success_refetch", null, false)).toBeNull();
    expect(writeErrorCopy("retry_same_key_after_refetch", null, true)).toBeNull();
  });
  it("says the last change was already saved for a 2xx stored reuse", () => {
    expect(writeErrorCopy("already_saved_refetch", err("IDEMPOTENCY_KEY_REUSED", "x", { storedStatus: 201 }), false))
      .toBe("Your last change was already saved. Check the invoice and try again.");
  });
  it("says the tap didn't go through for a non-2xx stored reuse", () => {
    expect(writeErrorCopy("spent_new_key", err("IDEMPOTENCY_KEY_REUSED", "x", { storedStatus: 409 }), false))
      .toBe("That tap didn't go through. Try again.");
  });
  it("shows the server message for message conflicts and stored codes", () => {
    expect(writeErrorCopy("show_message_refetch", err("STALE", "This job changed. Refresh and try again."), false))
      .toBe("This job changed. Refresh and try again.");
    expect(writeErrorCopy("refetch_new_key", err("EXCEEDS_BALANCE", "That's more than the balance due."), false))
      .toBe("That's more than the balance due.");
  });
  it("falls back to human copy without a server message", () => {
    expect(writeErrorCopy("show_message_refetch", null, false)).toBe("Couldn't save that. Try again.");
    expect(writeErrorCopy("retry_same_key_after_refetch", null, false))
      .toBe("Your last change may not have saved. Try again.");
    expect(writeErrorCopy("wait_then_refetch", null, false)).toBe("Still saving your last tap…");
  });
});

describe("small labels", () => {
  it("formats the tax rate", () => {
    expect(taxLabel(825)).toBe("Tax (8.25%)");
    expect(taxLabel(800)).toBe("Tax (8%)");
    expect(taxLabel(750)).toBe("Tax (7.5%)");
    expect(taxLabel(null)).toBe("Tax");
  });
  it("labels payments", () => {
    expect(paymentLabel("cash", null)).toBe("Cash");
    expect(paymentLabel("check", "1234")).toBe("Check #1234");
    expect(paymentLabel("check", null)).toBe("Check");
    expect(paymentLabel("card", null)).toBe("Card");
  });
  it("prompts with the material count", () => {
    expect(materialsPrompt(2)).toBe("Start from the 2 materials on this job.");
    expect(materialsPrompt(1)).toBe("Start from the 1 material on this job.");
    expect(materialsPrompt(0)).toBe("No materials on this job yet. Add items after you create it.");
  });
  it("describes non-image signature states", () => {
    expect(signatureCopy("none")).toBe("No signature");
    expect(signatureCopy("erased")).toBe("Signature removed");
    expect(signatureCopy("unavailable")).toBe("Signature unavailable");
    expect(signatureCopy("estimate")).toBe("Signed with the estimate");
    expect(signatureCopy("present")).toBeNull();
  });
});

describe("newInvoicePrompt", () => {
  it("names the materials when there are some", () => {
    expect(newInvoicePrompt(2)).toBe("Start from the 2 materials on this job.");
    expect(newInvoicePrompt(1)).toBe("Start from the 1 material on this job.");
  });

  it("falls back to a plain prompt", () => {
    expect(newInvoicePrompt(0)).toBe("Start a new invoice for this job.");
  });
});

describe("totalsFooter", () => {
  it("draft shows totals only", () => {
    expect(totalsFooter("draft", 1000, 1000)).toBeNull();
  });

  it("paid and refunded are keyed on state, not balance", () => {
    expect(totalsFooter("paid", 1000, 0)).toEqual({ kind: "paid", label: "Paid" });
    expect(totalsFooter("refunded", 1000, 1000)).toEqual({ kind: "note", label: "Refunded" });
    expect(totalsFooter("refunded", 1000, 0)).toEqual({ kind: "note", label: "Refunded" });
  });

  it("an open $0 invoice has nothing to collect", () => {
    expect(totalsFooter("open", 0, 0)).toEqual({ kind: "note", label: "Nothing to collect" });
  });

  it("an open invoice shows its balance", () => {
    expect(totalsFooter("open", 1000, 400)).toEqual({ kind: "balance", label: "Balance due", cents: 400 });
  });
});

describe("paymentStatusLabel", () => {
  it("omits succeeded", () => {
    expect(paymentStatusLabel("succeeded")).toBeNull();
  });

  it("labels other statuses in sentence case", () => {
    expect(paymentStatusLabel("refunded")).toBe("Refunded");
    expect(paymentStatusLabel("partially_refunded")).toBe("Partially refunded");
    expect(paymentStatusLabel("pending")).toBe("Pending");
  });
});
