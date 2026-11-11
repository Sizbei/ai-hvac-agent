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

/** "Issued today" / "Issued 1 day ago" / "Issued 12 days ago" — says what the
 * number measures, so it is never mistaken for days overdue. */
export function ageLabel(days: number): string {
  if (days <= 0) return 'Issued today';
  return days === 1 ? 'Issued 1 day ago' : `Issued ${days} days ago`;
}

/** Short list-row label ("91d old") — the row's issued-date column already says "issued". */
export function compactAgeLabel(days: number): string {
  return days <= 0 ? 'Today' : `${days}d old`;
}

// Status chip per the redesign spec: 3 px radius, 20 px tall, semantic
// light/border/strong triplet, 11 px. The label text ("Paid" / "12 days" /
// "863d overdue") is the primary disambiguator — no redundant dot glyph, which
// is reserved for the shared badge components.
const CHIP =
  'inline-flex h-5 items-center whitespace-nowrap rounded-[3px] border px-1.5 text-[11px] font-medium leading-none';
const CLS: Record<string, string> = {
  green: 'bg-success-light text-success-strong border-success-border',
  amber: 'bg-warning-light text-warning-strong border-warning-border',
  red: 'bg-danger-light text-danger-strong border-danger-border',
  neutral: 'bg-muted text-muted-foreground border-border',
};
const STATE_LABEL: Record<string, string> = { draft: 'Draft', void: 'Void', refunded: 'Refunded' };

export type AgeChipView = { label: string; tone: 'green' | 'amber' | 'red' | 'neutral'; mono: boolean };

/** What the chip says. Only an OPEN invoice has an age that matters: paid is
 * green; a draft, void or refunded invoice names its state in grey (a $0 FieldPulse
 * draft from 2023 must not read "1098 days" in red). */
export function ageChipView(inv: InvoiceAgeDates & { state: string }, compact: boolean, now: Date = new Date()): AgeChipView {
  if (inv.state === 'paid') return { label: 'Paid', tone: 'green', mono: false };
  if (inv.state !== 'open') return { label: STATE_LABEL[inv.state] ?? 'Closed', tone: 'neutral', mono: false };
  // Days PAST DUE is the number that matters for collections when the source
  // system gave us a due date (FP's issue dates are onboarding artifacts for
  // migrated books); otherwise fall back to age since issue. A past-due open
  // invoice is never green — the chip must agree with the Overdue filter.
  const overdueDays = daysPastDue(inv, now);
  if (overdueDays >= 1) return { label: `${overdueDays}d overdue`, tone: 'red', mono: true };
  const days = invoiceAgeDays(inv, now);
  const tone = overdueByDates(inv, now) ? 'red' : ageBucket(days);
  return { label: compact ? compactAgeLabel(days) : ageLabel(days), tone, mono: true };
}

export function AgeChip({ issuedAt, dueDate, createdAt, state, compact = false }: { issuedAt?: string | null; dueDate?: string | null; createdAt: string; state: string; compact?: boolean }) {
  const view = ageChipView({ issuedAt, dueDate, createdAt, state }, compact);
  return (
    <span className={`${CHIP} ${CLS[view.tone]}${view.mono ? ' font-mono tabular-nums' : ''}`}>
      {view.label}
    </span>
  );
}
