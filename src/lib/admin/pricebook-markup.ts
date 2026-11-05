/**
 * Cost ↔ markup ↔ price for the pricebook form. Markup is a whole percent on
 * cost (cost $60 + 200% markup = $180). Integer cents throughout.
 */

/** Price from cost and markup; null when either is missing or invalid. */
export function priceFromMarkup(costCents: number, markupPct: number): number | null {
  if (!Number.isFinite(costCents) || !Number.isFinite(markupPct)) return null;
  if (costCents <= 0 || markupPct < 0) return null;
  return Math.round(costCents * (1 + markupPct / 100));
}

/** Whole-percent markup implied by a price over cost; 0 without a cost. */
export function markupFromPrice(priceCents: number, costCents: number): number {
  if (costCents <= 0 || priceCents <= costCents) return 0;
  return Math.round(((priceCents - costCents) / costCents) * 100);
}
