/** Slice `rows` to the window for `page` (1-indexed) with `per` items per page. */
export function paginate<T>(rows: readonly T[], page: number, per: number): readonly T[] {
  const start = (page - 1) * per;
  if (start >= rows.length) return [];
  return rows.slice(start, start + per);
}

/**
 * Human-readable pager label.
 * Examples:
 *   pageLabel(1, 100, 50)  → "1–50 of 100"
 *   pageLabel(2, 100, 50)  → "51–100 of 100"
 *   pageLabel(1, 0, 50)    → "0 results"
 *   pageLabel(1, 30, 50)   → "1–30 of 30"
 */
export function pageLabel(page: number, total: number, per: number): string {
  if (total === 0) return '0 results';
  const start = (page - 1) * per + 1;
  const end = Math.min(page * per, total);
  return `${start}–${end} of ${total}`;
}

export type SortKey = 'newest' | 'oldest' | 'balance-high' | 'age-oldest';

export interface SortableInvoice {
  readonly createdAt: string;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly state: string;
}

/**
 * Sort a copy of `rows` by `key`. Does NOT mutate input.
 * - 'newest': createdAt descending
 * - 'oldest': createdAt ascending
 * - 'balance-high': (totalCents - amountPaidCents) descending
 * - 'age-oldest': (totalCents - amountPaidCents > 0 ? daysOld : -1) descending (unpaid first by age, paid last)
 */
export function sortInvoices<T extends SortableInvoice>(rows: readonly T[], key: SortKey): readonly T[] {
  const copy = [...rows];
  switch (key) {
    case 'newest':
      return copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    case 'oldest':
      return copy.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    case 'balance-high':
      return copy.sort((a, b) => {
        const balA = a.totalCents - a.amountPaidCents;
        const balB = b.totalCents - b.amountPaidCents;
        return balB - balA;
      });
    case 'age-oldest': {
      const now = Date.now();
      const daysOld = (inv: SortableInvoice) => {
        const balance = inv.totalCents - inv.amountPaidCents;
        if (balance <= 0) return -1;
        return (now - new Date(inv.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      };
      return copy.sort((a, b) => daysOld(b) - daysOld(a));
    }
  }
}
