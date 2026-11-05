/**
 * Running totals for the New estimate dialog, so Good/Better/Best can be
 * compared while they're built. Mirrors the server: catalog lines are priced
 * from the pricebook (member price when toggled), manual lines from the typed
 * dollars, quantity is a whole number ≥ 1, tax is the org's default rate.
 * The server re-prices on create — these are a preview, not the record.
 */
import { computeOptionTotals, type OptionTotals } from './money';
import { parseDollarsToCents } from './money-format';

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
    return [{ quantity: draftQuantity(l.quantity), unitPriceCents: parseDollarsToCents(l.unitPrice) }];
  });
  return computeOptionTotals(priced, taxBps);
}

/** The org's default tax rate, as the server picks it (active + default, else 0). */
export function defaultTaxBps(
  rates: ReadonlyArray<{ readonly rateBps: number; readonly isDefault: boolean; readonly active: boolean }>,
): number {
  return rates.find((r) => r.isDefault && r.active)?.rateBps ?? 0;
}
