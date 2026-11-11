/**
 * Pure display helpers for /admin/reports (no I/O, safe on client and server).
 */
import { formatCentsExact } from "./money-format";

/** The page's rule: a rate with nothing behind it renders "—", never "0%". */
export function formatRate(pct: number, denominator: number): string {
  return denominator > 0 ? `${pct}%` : "—";
}

interface LeadSourceLike {
  readonly leads: number;
  readonly booked: number;
  readonly revenueCents: number;
}

/**
 * Lead sources worth a row: anything with leads, bookings or revenue. The
 * query returns every enum value so a new shop would otherwise see a wall of
 * zero rows; the empty state covers "no leads at all".
 */
export function visibleLeadSources<T extends LeadSourceLike>(rows: readonly T[]): T[] {
  return rows.filter((r) => r.leads > 0 || r.booked > 0 || r.revenueCents !== 0);
}

/** What erasure writes into encrypted PII columns (erasure-queries.ts). */
export const ERASED_PLACEHOLDER = "[deleted]";

/** What the office reads for an address erasure blanked. */
export const ERASED_ADDRESS_LABEL = "Erased address";

/** First line of a stored address ("12 Oak St, Johnson City, TN" → "12 Oak St"). */
export function firstAddressLine(address: string | null | undefined): string | null {
  const line = address?.split(/[,\n]/)[0]?.trim();
  return line ? line : null;
}

/**
 * Name for a service location row: its label, then its dispatch zone, then the
 * first line of its address. Most locations have neither label nor zone, so
 * the address is the normal case.
 */
export function locationDisplayLabel(loc: {
  readonly label: string | null;
  readonly zone: string | null;
  readonly address: string | null;
}): string {
  const label = loc.label?.trim();
  if (label) return label;
  const zone = loc.zone?.trim();
  if (zone) return zone;
  // GDPR erasure overwrites the address with this placeholder.
  if (loc.address?.trim() === ERASED_PLACEHOLDER) return ERASED_ADDRESS_LABEL;
  return firstAddressLine(loc.address) ?? "Address not on file";
}

/** A 0–1 ratio as a whole percentage, or "—" when nothing is behind it. */
export function formatRatio(ratio: number, denominator: number): string {
  return denominator > 0 ? `${Math.round(ratio * 100)}%` : "—";
}

interface RevenueLike {
  readonly grossCollectedCents: number;
  readonly refundedCents: number;
  readonly netCollectedCents: number;
  readonly syncedCollectedCents: number;
}

/**
 * The Net revenue tile. An org on FieldPulse / HCP takes most of its money
 * there; that money only reaches us as paid-to-date on the mirrored invoices,
 * so the headline adds it to what was collected here (no invoice is in both)
 * and the sublabel names each part and its basis. Without synced money the
 * tile reads exactly as before.
 */
export function netRevenueTile(r: RevenueLike): { valueCents: number; sublabel: string } {
  if (r.syncedCollectedCents > 0) {
    return {
      valueCents: r.netCollectedCents + r.syncedCollectedCents,
      sublabel:
        `${formatCentsExact(r.syncedCollectedCents)} paid to date on FieldPulse/HCP invoices issued in the period · ` +
        `${formatCentsExact(r.netCollectedCents)} received here in the period, less refunds`,
    };
  }
  return {
    valueCents: r.netCollectedCents,
    sublabel: `${formatCentsExact(r.grossCollectedCents)} collected − ${formatCentsExact(r.refundedCents)} refunded`,
  };
}

/** "7 sold of 115 estimates": the close rate counts every estimate, open ones too. */
export function closeRateSublabel(sold: number, created: number): string {
  return `${sold} sold of ${created} ${created === 1 ? "estimate" : "estimates"}`;
}

const LEAD_SOURCE_LABELS: Record<string, string> = {
  google: "Google",
  facebook: "Facebook",
  yelp: "Yelp",
  referral: "Referral",
  repeat_customer: "Repeat customer",
  website: "Website",
  direct_mail: "Direct mail",
  other: "Other",
  // Imported jobs and older requests carry no lead source.
  unknown: "Not recorded",
};

/** Human lead-source name; an unmapped code is sentence-cased, never shown raw. */
export function leadSourceLabel(source: string): string {
  const known = LEAD_SOURCE_LABELS[source];
  if (known) return known;
  const words = source.replace(/_/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : "Not recorded";
}
