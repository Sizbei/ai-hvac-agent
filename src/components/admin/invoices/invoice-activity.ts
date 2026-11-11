import type { InvoiceDetailView, InvoiceReminderView } from '@/lib/admin/invoice-queries';
import { daysBetween, invoiceAgeDays, overdueByDates } from './age-chip';
import { formatCentsExact } from '@/lib/admin/money-format';
import { paymentMethodLabel } from '@/lib/admin/invoice-payment-copy';

export type ActivityEvent = {
  kind: 'created' | 'payment' | 'refund' | 'reminder';
  at: Date;
  label: string;
};

/** Pure relative-time formatter. Accepts explicit `now` for testability. */
function rel(date: Date, now: Date): string {
  const diffMs = now.getTime() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function collectionsStats(
  inv: Pick<
    InvoiceDetailView,
    'createdAt' | 'state' | 'totalCents' | 'amountPaidCents' | 'lastReminderSentAt'
  > &
    Partial<Pick<InvoiceDetailView, 'issuedAt' | 'dueDate'>>,
  now: Date,
): { daysOverdue: number | null; lastRemindedRel: string | null; balanceCents: number } {
  const balance = inv.totalCents - inv.amountPaidCents;
  // With a source-system due date, "overdue" = days past due; otherwise the
  // legacy heuristic: age (from real issue date when known) >= 30 days.
  const overdue = inv.state === 'open' && balance > 0 && overdueByDates(inv, now);
  const daysOverdue = overdue
    ? inv.dueDate != null
      ? daysBetween(new Date(inv.dueDate), now)
      : invoiceAgeDays(inv, now)
    : null;
  const lastRemindedRel =
    inv.lastReminderSentAt ? rel(inv.lastReminderSentAt, now) : null;
  return { daysOverdue, lastRemindedRel, balanceCents: balance };
}

const SOURCE_NAME = { fieldpulse: 'FieldPulse', housecall: 'Housecall Pro' } as const;

export function buildActivity(
  inv: Pick<InvoiceDetailView, 'createdAt' | 'lastReminderSentAt' | 'payments'> &
    Partial<Pick<InvoiceDetailView, 'issuedAt' | 'syncedSource'>>,
  reminders: InvoiceReminderView[] = [],
): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  // A mirrored invoice was created in its source system on its issue date;
  // our createdAt is only the import run, which read as "created" after its
  // own payments.
  const source = inv.syncedSource ? SOURCE_NAME[inv.syncedSource] : null;
  events.push(
    source
      ? { kind: 'created', at: inv.issuedAt ?? inv.createdAt, label: `Invoice created in ${source}` }
      : { kind: 'created', at: inv.createdAt, label: 'Invoice created' },
  );

  for (const payment of inv.payments) {
    // Amount and method, so the trail reads without opening Payments.
    events.push({
      kind: 'payment',
      at: payment.createdAt,
      label:
        payment.provider === 'fieldpulse'
          ? `Payment recorded in FieldPulse · ${formatCentsExact(payment.amountCents)}`
          : `Payment recorded · ${formatCentsExact(payment.amountCents)} · ${paymentMethodLabel(payment.method)}`,
    });
    for (const refund of payment.refunds ?? []) {
      events.push({
        kind: 'refund',
        at: refund.createdAt,
        label: `Refund issued · ${formatCentsExact(refund.amountCents)}`,
      });
    }
  }

  if (reminders.length > 0) {
    for (const r of reminders) {
      events.push({ kind: 'reminder', at: r.at, label: 'Reminder sent' });
    }
  } else if (inv.lastReminderSentAt) {
    events.push({ kind: 'reminder', at: inv.lastReminderSentAt, label: 'Reminder sent' });
  }

  return events.sort((a, b) => b.at.getTime() - a.at.getTime());
}
