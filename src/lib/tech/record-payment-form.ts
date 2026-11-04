/**
 * Pure logic for the S40 "Record payment" sheet (spec §7.4): the amount
 * parser and max-balance check (run BEFORE posting), the "Record $x" label,
 * the request body and the remembered method. Tests run in node.
 */
import { formatCentsExact, MAX_PRICE_CENTS } from "@/lib/admin/money-format";

export type TechPaymentMethod = "cash" | "check";

export const LAST_METHOD_KEY = "tech:lastPaymentMethod";
export const CHECK_NUMBER_MAX = 32;

/** A stored method from localStorage; anything unexpected → "cash". */
export function parseStoredMethod(raw: string | null): TechPaymentMethod {
  return raw === "check" ? "check" : "cash";
}

const DOLLARS = /^\d*(\.\d{0,2})?$/;

/** "$1,234.50" → 123450; null for anything that isn't a plain dollar amount. */
export function parseAmountCents(input: string): number | null {
  const s = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (s === "" || s === "." || !DOLLARS.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const cents = Number(whole || "0") * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents <= MAX_PRICE_CENTS ? cents : null;
}

export type RecordFormResult = { ok: true; amountCents: number } | { ok: false; error: string };

export function validateRecordForm(f: {
  amount: string;
  balanceCents: number;
  method: TechPaymentMethod;
  checkNumber: string;
}): RecordFormResult {
  const cents = parseAmountCents(f.amount);
  if (cents === null) return { ok: false, error: "Enter an amount like 125.00." };
  if (cents < 1) return { ok: false, error: "Enter an amount greater than zero." };
  if (cents > f.balanceCents) return { ok: false, error: "That's more than the balance due." };
  if (f.method === "check" && f.checkNumber.trim().length > CHECK_NUMBER_MAX) {
    return { ok: false, error: "Check number is too long." };
  }
  return { ok: true, amountCents: cents };
}

export function recordLabel(amountCents: number | null): string {
  return amountCents !== null && amountCents > 0 ? `Record ${formatCentsExact(amountCents)}` : "Record payment";
}

export function inFlightCopy(amountCents: number): string {
  return `Finishing your last tap: ${formatCentsExact(amountCents)}`;
}

export function paymentSuccessCopy(customerHasPhone: boolean): string {
  return customerHasPhone ? "Payment recorded. A receipt is texted if the customer accepts texts." : "Payment recorded.";
}

export interface PaymentBody {
  readonly invoiceId: string;
  readonly method: TechPaymentMethod;
  readonly amountCents: number;
  readonly checkNumber?: string;
}

/** The route refuses a check number on cash; a blank one is left out. */
export function buildPaymentBody(
  invoiceId: string,
  method: TechPaymentMethod,
  amountCents: number,
  checkNumber: string,
): PaymentBody {
  const n = checkNumber.trim();
  return method === "check" && n ? { invoiceId, method, amountCents, checkNumber: n } : { invoiceId, method, amountCents };
}
