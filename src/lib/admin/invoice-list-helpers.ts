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

/**
 * "Collected this month" counts payments taken in this app only (FieldPulse /
 * Housecall Pro payment mirrors are record-only, see
 * src/lib/integrations/fieldpulse/import/payments.ts). With synced invoices on
 * the books the tile must say so, or $0.00 reads as "nothing came in".
 */
export function collectedThisMonthSublabel(hasSyncedInvoices: boolean): string {
  return hasSyncedInvoices
    ? "Paid here since the 1st · FieldPulse/HCP not included"
    : "Received since the 1st, less refunds";
}
