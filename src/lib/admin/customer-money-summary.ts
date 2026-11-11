/**
 * Pure helpers for the customer profile's Invoices and Estimates cards: the
 * header totals and the "show the newest few, then Show all" split. A
 * customer imported from FieldPulse can carry 100+ invoices; listing them all
 * by default buried the rest of the profile.
 */

/** Rows shown before "Show all". */
export const PROFILE_LIST_PREVIEW = 8;

interface InvoiceLike {
  readonly state: string;
  readonly totalCents: number;
  readonly amountPaidCents: number;
}

export interface InvoiceSummary {
  /** Lifetime billed: every invoice that isn't a draft or void. */
  readonly billedCents: number;
  /** What is still owed on open invoices. */
  readonly openBalanceCents: number;
  readonly openCount: number;
}

/** What is still owed on one invoice: only open invoices owe, never below 0. */
export function invoiceBalanceCents(inv: InvoiceLike): number {
  if (inv.state !== 'open') return 0;
  return Math.max(0, inv.totalCents - inv.amountPaidCents);
}

export function summarizeInvoices(invoices: readonly InvoiceLike[]): InvoiceSummary {
  let billedCents = 0;
  let openBalanceCents = 0;
  let openCount = 0;
  for (const inv of invoices) {
    if (inv.state !== 'draft' && inv.state !== 'void') billedCents += inv.totalCents;
    const balance = invoiceBalanceCents(inv);
    if (balance > 0) {
      openBalanceCents += balance;
      openCount += 1;
    }
  }
  return { billedCents, openBalanceCents, openCount };
}

/** The rows to render: all when expanded or short, else the first `preview`. */
export function previewRows<T>(rows: readonly T[], expanded: boolean, preview = PROFILE_LIST_PREVIEW): readonly T[] {
  return expanded || rows.length <= preview ? rows : rows.slice(0, preview);
}

/** The one source every synced row shares ("fieldpulse"), null when the list
 * is native-only or mixed — then each row carries its own pill. */
export function sharedSyncSource<S extends string>(
  rows: readonly { readonly syncedSource: S | null }[],
): S | null {
  if (rows.length === 0) return null;
  const first = rows[0]!.syncedSource;
  if (first === null) return null;
  return rows.every((r) => r.syncedSource === first) ? first : null;
}
