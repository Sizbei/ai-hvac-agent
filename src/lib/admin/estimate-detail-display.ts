/**
 * The office estimate detail's invoice card and its dates (M3c final wave).
 * Pure and client-safe.
 */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";

export type EstimateInvoiceCard =
  | { readonly kind: "office"; readonly invoiceId: string }
  | { readonly kind: "job"; readonly invoiceId: string }
  | { readonly kind: "generate" };

/**
 * An office invoice (any state) → "Invoice created" with its link; the sold
 * option's lines on the job's invoice → "On the job's invoice" with that link;
 * otherwise Generate (final review B P2-1).
 */
export function estimateInvoiceCard(e: { readonly invoiceId: string | null; readonly jobInvoiceId: string | null }): EstimateInvoiceCard {
  if (e.invoiceId) return { kind: "office", invoiceId: e.invoiceId };
  if (e.jobInvoiceId) return { kind: "job", invoiceId: e.jobInvoiceId };
  return { kind: "generate" };
}

const TZ = BUSINESS_BASE_LOCATION.timezone;

/** "Nov 6, 10:26 PM" in the business timezone, not the viewer's (final review B P2-2). */
export function businessWhen(iso: string, timeZone: string = TZ): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** "Nov 6, 2026" in the business timezone. */
export function businessDay(iso: string, timeZone: string = TZ): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
}

/**
 * An option's heading. The FieldPulse import puts each estimate in one option
 * named "FieldPulse" (the sync pill already says where it came from), so that
 * one reads "Estimate"; real option names (Good / Better / Best) stay.
 */
export function estimateOptionTitle(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" || trimmed === "FieldPulse" ? "Estimate" : trimmed;
}
