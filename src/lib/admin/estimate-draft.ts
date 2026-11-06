/**
 * Running totals for the New estimate dialog, so Good/Better/Best can be
 * compared while they're built. Mirrors the server: catalog lines are priced
 * from the pricebook (member price when toggled), manual lines from the typed
 * dollars, quantity is a whole number ≥ 1, tax is the org's default rate.
 * The server re-prices on create — these are a preview, not the record.
 */
import { computeOptionTotals, type OptionTotals } from './money';
import { parseMoneyInput } from './money-format';

export interface DraftLine {
  readonly name: string;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly pricebookItemId: string | null;
  readonly useMemberPrice: boolean;
}

export interface DraftCatalogItem {
  readonly priceCents: number;
  readonly memberPriceCents: number | null;
}

export function draftQuantity(raw: string): number {
  return Math.max(1, parseInt(raw, 10) || 1);
}

/** A manual line's typed price in cents; blank or invalid previews as $0. */
function draftUnitCents(raw: string): number {
  const parsed = parseMoneyInput(raw);
  return parsed.ok ? parsed.cents : 0;
}

/**
 * The first manual line whose typed price is not dollars and cents
 * ("1.999", "abc"), as a human message; null when every price is usable.
 * A blank price is allowed (a $0 line).
 */
export function draftLinePriceError(
  options: ReadonlyArray<{ readonly lineItems: readonly DraftLine[] }>,
): string | null {
  for (const o of options) {
    for (const l of o.lineItems) {
      if (l.pricebookItemId || !l.name.trim() || !l.unitPrice.trim()) continue;
      const parsed = parseMoneyInput(l.unitPrice);
      if (!parsed.ok) return `Price for “${l.name.trim()}”: ${parsed.error}`;
    }
  }
  return null;
}

/**
 * Whether the New estimate dialog holds work the office would lose on Esc or
 * a click outside: a picked customer, a title, a second option, a renamed
 * option, or any line with an item, name or price.
 */
export function isEstimateDraftDirty(draft: {
  readonly pickedCustomer: boolean;
  readonly title: string;
  readonly options: ReadonlyArray<{ readonly name: string; readonly lineItems: readonly DraftLine[] }>;
}): boolean {
  if (draft.pickedCustomer || draft.title.trim() !== '') return true;
  if (draft.options.length > 1) return true;
  return draft.options.some(
    (o) =>
      o.name.trim() !== 'Good' ||
      o.lineItems.length > 1 ||
      o.lineItems.some(
        (l) => l.pricebookItemId !== null || l.name.trim() !== '' || l.unitPrice.trim() !== '',
      ),
  );
}

export function draftOptionTotals(
  lines: readonly DraftLine[],
  itemById: ReadonlyMap<string, DraftCatalogItem>,
  taxBps: number,
): OptionTotals {
  const priced = lines.flatMap((l) => {
    if (l.pricebookItemId) {
      const item = itemById.get(l.pricebookItemId);
      if (!item) return [];
      const unit =
        l.useMemberPrice && item.memberPriceCents != null ? item.memberPriceCents : item.priceCents;
      return [{ quantity: draftQuantity(l.quantity), unitPriceCents: unit }];
    }
    if (!l.name.trim()) return [];
    return [{ quantity: draftQuantity(l.quantity), unitPriceCents: draftUnitCents(l.unitPrice) }];
  });
  return computeOptionTotals(priced, taxBps);
}

/** The org's default tax rate, as the server picks it (active + default, else 0). */
export function defaultTaxBps(
  rates: ReadonlyArray<{ readonly rateBps: number; readonly isDefault: boolean; readonly active: boolean }>,
): number {
  return rates.find((r) => r.isDefault && r.active)?.rateBps ?? 0;
}
