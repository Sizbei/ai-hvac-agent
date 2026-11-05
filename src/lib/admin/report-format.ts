/**
 * Pure display helpers for /admin/reports (no I/O, safe on client and server).
 */

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
  if (loc.address?.trim() === ERASED_PLACEHOLDER) return "Erased address";
  return firstAddressLine(loc.address) ?? "Address not on file";
}
