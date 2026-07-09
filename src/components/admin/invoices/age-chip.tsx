'use client';
const DAY_MS = 24 * 60 * 60 * 1000;
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}
export function ageBucket(days: number): 'green' | 'amber' | 'red' {
  if (days >= 60) return 'red';
  if (days >= 30) return 'amber';
  return 'green';
}

/** The date fields age/overdue math needs. `issuedAt`/`dueDate` come from the
 * source system for mirrored invoices (FieldPulse/HCP) and are null for native
 * ones; `createdAt` (row insertion) is only the fallback — for mirrored rows
 * it is the IMPORT time and made everything look 0 days old. */
export type InvoiceAgeDates = {
  issuedAt?: string | Date | null;
  dueDate?: string | Date | null;
  createdAt: string | Date;
};

/** Age in whole days since the invoice was actually issued (falls back to
 * row-creation time for native invoices). */
export function invoiceAgeDays(inv: InvoiceAgeDates, now: Date = new Date()): number {
  return daysBetween(new Date(inv.issuedAt ?? inv.createdAt), now);
}

/** Date-based overdue test: past the source system's due date when one exists,
 * else the legacy age >= 30 days heuristic. State/balance checks (e.g.
 * isCollectible) stay at the call site. */
export function overdueByDates(inv: InvoiceAgeDates, now: Date = new Date()): boolean {
  if (inv.dueDate != null) {
    return daysPastDue(inv, now) >= 1;
  }
  return invoiceAgeDays(inv, now) >= 30;
}

/** Whole days past the due date; 0 when not yet due or no due date. */
export function daysPastDue(inv: InvoiceAgeDates, now: Date = new Date()): number {
  return inv.dueDate != null ? daysBetween(new Date(inv.dueDate), now) : 0;
}

const CLS: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-700', amber: 'bg-amber-100 text-amber-700',
  red: 'bg-rose-100 text-rose-700',
};
export function AgeChip({ issuedAt, dueDate, createdAt, state }: { issuedAt?: string | null; dueDate?: string | null; createdAt: string; state: string }) {
  if (state === 'paid') {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700"><span className="size-1.5 rounded-full bg-emerald-600" />Paid</span>;
  }
  // Days PAST DUE is the number that matters for collections when the source
  // system gave us a due date (FP's issue dates are onboarding artifacts for
  // migrated books); otherwise fall back to age since issue. A past-due open
  // invoice is never green — the chip must agree with the Overdue filter.
  const overdueDays = state === 'open' ? daysPastDue({ issuedAt, dueDate, createdAt }) : 0;
  if (overdueDays >= 1) {
    return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${CLS.red}`}><span className="size-1.5 rounded-full bg-current opacity-70" />{overdueDays}d overdue</span>;
  }
  const days = invoiceAgeDays({ issuedAt, createdAt });
  const b = state === 'open' && overdueByDates({ issuedAt, dueDate, createdAt }) ? 'red' : ageBucket(days);
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${CLS[b]}`}><span className="size-1.5 rounded-full bg-current opacity-70" />{days} days</span>;
}
