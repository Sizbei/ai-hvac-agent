/**
 * Pure copy for the field invoice page and the job's Invoice card (spec §7).
 * Sentence case, "job" (technician copy), no exclamation marks.
 */
import { formatCentsExact } from "@/lib/admin/money-format";
import type { SignatureState, TechInvoiceState } from "./invoice-view";
import type { WriteOutcome } from "./invoice-key-state";

export function invoiceChipLabel(s: { state: string; balanceCents: number } | null): string {
  if (!s) return "No invoice yet";
  switch (s.state) {
    case "draft":
      return "Draft";
    case "open":
      return `Open · ${formatCentsExact(s.balanceCents)} due`;
    case "paid":
      return "Paid";
    case "refunded":
      return "Refunded";
    default:
      return "Void";
  }
}

/** The `{ success: false, error }` envelope, as far as the copy needs it. */
export interface ErrorEnvelopeLike {
  readonly success?: boolean;
  readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown };
}

const REUSED_SAVED = "Your last change was already saved. Check the invoice and try again.";
const REUSED_FAILED = "That tap didn't go through. Try again.";
const FALLBACK = "Couldn't save that. Try again.";

/**
 * The inline message after a write (spec §7.6). `dropped` = the refetch showed
 * the write landed, so the refetched state speaks for itself.
 */
export function writeErrorCopy(
  outcome: WriteOutcome,
  envelope: ErrorEnvelopeLike | null,
  dropped: boolean,
): string | null {
  if (dropped || outcome === "success_refetch") return null;
  const code = envelope?.error?.code;
  const message = envelope?.error?.message;
  switch (outcome) {
    case "already_saved_refetch":
      return REUSED_SAVED;
    case "retry_same_key_after_refetch":
      return "Your last change may not have saved. Try again.";
    case "wait_then_refetch":
      return "Still saving your last tap…";
    case "spent_new_key":
      if (code === "IDEMPOTENCY_KEY_REUSED") return REUSED_FAILED;
      return message ?? FALLBACK;
    default:
      return message ?? FALLBACK;
  }
}

/** 825 → "Tax (8.25%)"; null (finalized) → "Tax". */
export function taxLabel(taxBps: number | null): string {
  if (taxBps === null) return "Tax";
  const pct = (taxBps / 100).toFixed(2).replace(/\.?0+$/, "");
  return `Tax (${pct}%)`;
}

export function paymentLabel(method: string, checkNumber: string | null): string {
  if (method === "check") return checkNumber ? `Check #${checkNumber}` : "Check";
  if (method === "cash") return "Cash";
  if (method === "card") return "Card";
  return method.charAt(0).toUpperCase() + method.slice(1);
}

export function materialsPrompt(n: number): string {
  if (n === 0) return "No materials on this job yet. Add items after you create it.";
  return `Start from the ${n} ${n === 1 ? "material" : "materials"} on this job.`;
}

/** Copy for a signature with no image to show; null when the image renders. */
export function signatureCopy(state: SignatureState): string | null {
  switch (state) {
    case "none":
      return "No signature";
    case "erased":
      return "Signature removed";
    case "unavailable":
      return "Signature unavailable";
    case "estimate":
      return "Signed with the estimate";
    case "present":
      return null;
  }
}

/** The prompt above "Create invoice" once the shown invoice is paid or refunded. */
export function newInvoicePrompt(materialCount: number): string {
  return materialCount > 0 ? materialsPrompt(materialCount) : "Start a new invoice for this job.";
}

export type TotalsFooter =
  | { readonly kind: "balance"; readonly label: "Balance due"; readonly cents: number }
  | { readonly kind: "paid"; readonly label: "Paid" }
  | { readonly kind: "note"; readonly label: "Refunded" | "Nothing to collect" };

/** The line under the totals, keyed on the invoice state; null for a draft (totals only). */
export function totalsFooter(state: TechInvoiceState, totalCents: number, balanceCents: number): TotalsFooter | null {
  switch (state) {
    case "draft":
      return null;
    case "paid":
      return { kind: "paid", label: "Paid" };
    case "refunded":
      return { kind: "note", label: "Refunded" };
    case "open":
      return totalCents === 0
        ? { kind: "note", label: "Nothing to collect" }
        : { kind: "balance", label: "Balance due", cents: balanceCents };
  }
}

/** A payment's status next to its method; null for a succeeded payment (the usual case). */
export function paymentStatusLabel(status: string): string | null {
  if (status === "succeeded") return null;
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ");
}
