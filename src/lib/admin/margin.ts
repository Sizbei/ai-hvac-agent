/**
 * Stage 10 — job costing / margin visibility (ADMIN-ONLY).
 *
 * Margin = revenue minus snapshotted cost, both in integer cents.
 *   marginCents = revenueCents - costCents
 *   marginPct   = revenueCents > 0 ? (revenueCents - costCents) / revenueCents : 0
 *
 * marginPct is a RATIO (e.g. 0.4 = 40%), not cents — so it is the only value
 * here that is not an integer. Cents are never rounded. costCents is sensitive
 * internal data: callers MUST keep it out of public/customer-facing surfaces.
 */
export interface Margin {
  readonly marginCents: number;
  readonly marginPct: number;
}

export interface MarginRollup {
  readonly revenueCents: number;
  readonly costCents: number;
  readonly marginCents: number;
  readonly marginPct: number;
}

/** Margin for a single revenue/cost pair. Negative when cost exceeds revenue. */
export function computeMargin(revenueCents: number, costCents: number): Margin {
  const marginCents = revenueCents - costCents;
  const marginPct = revenueCents > 0 ? marginCents / revenueCents : 0;
  return { marginCents, marginPct };
}

/** A line whose revenue (lineTotalCents) and snapshotted cost roll up to a total. */
export interface MarginLine {
  readonly costCents: number;
  readonly lineTotalCents: number;
}

/** Sum line revenue + cost, then compute the rolled-up margin over the set. */
export function rollUpMargin(lines: readonly MarginLine[]): MarginRollup {
  const revenueCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
  const costCents = lines.reduce((sum, l) => sum + l.costCents, 0);
  const { marginCents, marginPct } = computeMargin(revenueCents, costCents);
  return { revenueCents, costCents, marginCents, marginPct };
}
