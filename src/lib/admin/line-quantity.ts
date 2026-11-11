/**
 * Display quantity for an invoice or estimate line. Pure and client-safe.
 *
 * The `quantity` column is an integer, so a FieldPulse line of 4.55 labor hours
 * is stored as 5 while its money (unit price and line total) stays exact
 * (`displayQuantity` in src/lib/integrations/fieldpulse/line-item-display.ts).
 * Shown as stored, "5 × $90.00 = $409.50" doesn't add up. When the total
 * divided by the unit price is a quantity that rounds to the stored one, that
 * exact quantity is the real one; otherwise (a discount, a $0 unit price) the
 * stored quantity stands.
 */
export interface QuantityLine {
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly lineTotalCents: number;
}

export function lineQuantity(li: QuantityLine): number {
  if (li.unitPriceCents === 0 || li.quantity * li.unitPriceCents === li.lineTotalCents) return li.quantity;
  const exact = Math.round((li.lineTotalCents / li.unitPriceCents) * 100) / 100;
  if (!Number.isFinite(exact) || exact <= 0) return li.quantity;
  return Math.max(1, Math.round(exact)) === li.quantity ? exact : li.quantity;
}

/** "4.55", "2.5", "3". */
export function lineQuantityLabel(li: QuantityLine): string {
  return String(lineQuantity(li));
}
