/**
 * Pure copy + body helpers for the admin invoice detail's money controls
 * (Record payment, Finalize, refunds). Extracted so they are unit-testable
 * without a component harness. Never surfaces a raw error code.
 */

export type RecordMethod = "cash" | "check" | "other";

/** No Card option in M3b — card payments stay behind the provider gate. */
export const RECORD_PAYMENT_METHODS: ReadonlyArray<{ value: RecordMethod; label: string }> = [
  { value: "cash", label: "Cash" },
  { value: "check", label: "Check" },
  { value: "other", label: "Other" },
];

const RECORD_ERRORS: Readonly<Record<string, string>> = {
  EXCEEDS_BALANCE: "That's more than the balance due.",
  INVOICE_NOT_CHARGEABLE: "Finalize the invoice first.",
  // Spec §8 said "That payment token was already used. Try again."; changed in
  // the final wave because a reused token usually means the first try landed.
  ID_CONFLICT: "This payment may already be recorded. Check the payments list before recording it again.",
  STALE: "This invoice changed. Refresh and try again.",
  INVOICE_SYNCED_READ_ONLY: "This invoice is managed in FieldPulse.",
};

export function recordPaymentErrorCopy(code: string | undefined): string {
  return (code && RECORD_ERRORS[code]) || "Couldn't record the payment. Please try again.";
}

/** A thrown fetch: the payment may have landed, so the form reloads the invoice first. */
export const RECORD_PAYMENT_NETWORK_COPY =
  "Couldn't reach the server. The payment may have been recorded. Check the list before trying again.";

/** A thrown fetch on a refund: same uncertainty, same reload-first rule. */
export const REFUND_NETWORK_COPY =
  "Couldn't reach the server. The refund may have been recorded. Check the list before trying again.";

/**
 * The outcome is uncertain (the write may have landed): a network error
 * (`code === null`) or an ID_CONFLICT. The office reloads the invoice before
 * showing the message so the payments list is current.
 */
export function shouldReloadAfterRecord(code: string | null | undefined): boolean {
  return code === null || code === "ID_CONFLICT";
}

const REFUND_ERRORS: Readonly<Record<string, string>> = {
  ID_CONFLICT: "That refund token was already used. Try again.",
  EXCEEDS_PAYMENT: "That's more than is left to refund on this payment.",
  NOT_REFUNDABLE: "This payment can't be refunded.",
  STALE: "This payment changed. Refresh and try again.",
  INVOICE_SYNCED_READ_ONLY: "This invoice is managed in FieldPulse.",
};

export function refundErrorCopy(code: string | undefined): string {
  return (code && REFUND_ERRORS[code]) || "Couldn't record the refund. Please try again.";
}

/**
 * Hand-recorded payments (cash/check/other) only on an OPEN invoice: a draft is
 * never payable by hand — Finalize is the only money action on a draft (spec §8).
 * `canTakePayment` (deriveInvoicePresentation) still covers balance + synced.
 */
export function canRecordPayment(input: { state: string; canTakePayment: boolean }): boolean {
  return input.state === "open" && input.canTakePayment;
}

const FINALIZE_ERRORS: Readonly<Record<string, string>> = {
  NO_LINES: "Add at least one item first.",
  INVOICE_LOCKED: "This invoice is already finalized.",
  STALE: "This invoice changed. Refresh and try again.",
};

export function finalizeErrorCopy(code: string | undefined): string {
  return (code && FINALIZE_ERRORS[code]) || "Couldn't finalize the invoice. Please try again.";
}

/** A client token is spent by a success or an ID_CONFLICT; anything else may retry with it. */
export function shouldRemintToken(ok: boolean, code: string | undefined): boolean {
  return ok || code === "ID_CONFLICT";
}

const METHOD_LABELS: Readonly<Record<string, string>> = {
  card: "Card",
  cash: "Cash",
  check: "Check",
  other: "Other",
};

export function paymentMethodLabel(method: string): string {
  return METHOD_LABELS[method] ?? "Other";
}

/** "Check · #1042" — the method chip text with its check number. */
export function paymentMethodSummary(method: string, checkNumber: string | null): string {
  const label = paymentMethodLabel(method);
  return checkNumber ? `${label} · #${checkNumber}` : label;
}

/** Extra success copy after a refund; manual money goes back by hand. */
export function refundSuccessCopy(provider: string): string | null {
  return provider === "manual"
    ? "Refund recorded. Return the money to the customer yourself."
    : null;
}

export interface RecordPaymentBody {
  readonly clientToken: string;
  readonly method: RecordMethod;
  readonly amountCents: number;
  readonly checkNumber?: string;
  readonly isDeposit: boolean;
}

export function buildRecordPaymentBody(input: {
  clientToken: string;
  method: RecordMethod;
  amountCents: number;
  checkNumber: string;
  isDeposit: boolean;
}): RecordPaymentBody {
  const checkNumber = input.method === "check" ? input.checkNumber.trim() : "";
  return {
    clientToken: input.clientToken,
    method: input.method,
    amountCents: input.amountCents,
    ...(checkNumber ? { checkNumber } : {}),
    isDeposit: input.isDeposit,
  };
}
