/**
 * Display quantity for a mirrored FieldPulse line item.
 *
 * The native `quantity` column is an integer, but FieldPulse quantities are
 * fractional (2.5 hours, 4.13 units) and the money is always computed from the
 * exact fraction. So this value is for the screen only — and its single job is
 * to never contradict the money sitting next to it.
 *
 * Two ways to get that wrong, both of which have shipped here:
 *
 *  - Flooring at 1 (`Math.max(1, …)`) renders "1 × $5,500.00" against a line
 *    whose total is $0.00, because FieldPulse sends `quantity: "0"` to mean the
 *    component contributes nothing.
 *  - Flooring at 0 (`Math.max(0, Math.round(…))`) renders "0 × $100.00" against
 *    a line whose total is $25.00, because a 0.25-hour line rounds to zero.
 *
 * The rule that satisfies both: zero means zero, and anything above zero shows
 * as at least one. A fractional quantity is still approximated — that is
 * inherent to an integer column — but it can no longer read as free or as
 * nothing.
 */
export function displayQuantity(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.max(1, Math.round(quantity));
}
