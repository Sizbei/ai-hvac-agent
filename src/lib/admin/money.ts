/**
 * Money math for the sales spine (Stage 8/9). Everything is integer cents; tax
 * rates are basis points (825 = 8.25%). Pure + unit-tested.
 */
export interface LineItemInput {
  readonly quantity: number;
  readonly unitPriceCents: number;
}

export interface OptionTotals {
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
}

/** Line total = quantity × unit price (clamped non-negative). */
export function lineTotalCents(line: LineItemInput): number {
  return Math.max(0, Math.round(line.quantity) * Math.max(0, line.unitPriceCents));
}

/** Subtotal + tax (banker's-free round-half-up) + total for a set of lines. */
export function computeOptionTotals(
  lines: readonly LineItemInput[],
  taxBps: number,
): OptionTotals {
  const subtotalCents = lines.reduce((sum, l) => sum + lineTotalCents(l), 0);
  const taxCents = Math.round((subtotalCents * Math.max(0, taxBps)) / 10000);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** A deposit of `pct` percent of a total, in cents (e.g. 50 → 50%). */
export function depositCents(totalCents: number, pct: number): number {
  return Math.round((totalCents * Math.max(0, Math.min(100, pct))) / 100);
}
