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
