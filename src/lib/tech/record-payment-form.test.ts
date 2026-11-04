import { describe, expect, it } from "vitest";
import {
  LAST_METHOD_KEY,
  buildPaymentBody,
  inFlightCopy,
  parseAmountCents,
  parseStoredMethod,
  paymentSuccessCopy,
  recordLabel,
  validateRecordForm,
} from "./record-payment-form";

describe("parseAmountCents", () => {
  it("parses dollars strictly", () => {
    expect(parseAmountCents("12.34")).toBe(1234);
    expect(parseAmountCents("$1,234.5")).toBe(123450);
    expect(parseAmountCents(" 7 ")).toBe(700);
    expect(parseAmountCents(".5")).toBe(50);
  });
  it("rejects junk", () => {
    expect(parseAmountCents("")).toBeNull();
    expect(parseAmountCents("12abc")).toBeNull();
    expect(parseAmountCents("1.234")).toBeNull();
    expect(parseAmountCents("-5")).toBeNull();
  });
});

describe("validateRecordForm", () => {
  const ok = { amount: "12.34", balanceCents: 5000, method: "cash" as const, checkNumber: "" };
  it("accepts an amount up to the balance", () => {
    expect(validateRecordForm(ok)).toEqual({ ok: true, amountCents: 1234 });
    expect(validateRecordForm({ ...ok, amount: "50.00" })).toEqual({ ok: true, amountCents: 5000 });
  });
  it("amount > balance → error before posting", () => {
    expect(validateRecordForm({ ...ok, amount: "50.01" })).toEqual({ ok: false, error: "That's more than the balance due." });
  });
  it("0 → error", () => {
    expect(validateRecordForm({ ...ok, amount: "0" })).toEqual({ ok: false, error: "Enter an amount greater than zero." });
  });
  it("junk → error", () => {
    expect(validateRecordForm({ ...ok, amount: "abc" })).toEqual({ ok: false, error: "Enter an amount like 125.00." });
  });
  it("check number over 32 characters → error", () => {
    expect(validateRecordForm({ ...ok, method: "check", checkNumber: "1".repeat(33) })).toEqual({
      ok: false,
      error: "Check number is too long.",
    });
  });
});

describe("labels and copy", () => {
  it("Record $12.34", () => {
    expect(recordLabel(1234)).toBe("Record $12.34");
    expect(recordLabel(null)).toBe("Record payment");
  });
  it("in-flight copy", () => {
    expect(inFlightCopy(1234)).toBe("Finishing your last tap: $12.34");
  });
  it("success copy depends on a phone", () => {
    expect(paymentSuccessCopy(true)).toBe("Payment recorded. A receipt is texted if the customer accepts texts.");
    expect(paymentSuccessCopy(false)).toBe("Payment recorded.");
  });
});

describe("parseStoredMethod", () => {
  it("uses the key tech:lastPaymentMethod", () => {
    expect(LAST_METHOD_KEY).toBe("tech:lastPaymentMethod");
  });
  it("valid values round-trip; anything else → cash", () => {
    expect(parseStoredMethod("check")).toBe("check");
    expect(parseStoredMethod("cash")).toBe("cash");
    expect(parseStoredMethod("card")).toBe("cash");
    expect(parseStoredMethod(null)).toBe("cash");
    expect(parseStoredMethod("")).toBe("cash");
  });
});

describe("buildPaymentBody", () => {
  it("drops the check number for cash and blank checks", () => {
    expect(buildPaymentBody("inv", "cash", 100, "123")).toEqual({ invoiceId: "inv", method: "cash", amountCents: 100 });
    expect(buildPaymentBody("inv", "check", 100, "  ")).toEqual({ invoiceId: "inv", method: "check", amountCents: 100 });
    expect(buildPaymentBody("inv", "check", 100, " 1234 ")).toEqual({
      invoiceId: "inv",
      method: "check",
      amountCents: 100,
      checkNumber: "1234",
    });
  });
});
