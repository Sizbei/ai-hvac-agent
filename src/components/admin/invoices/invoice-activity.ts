import type { InvoiceDetailView } from '@/lib/admin/invoice-queries';
import { daysBetween } from './age-chip';

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
  >,
  now: Date,
): { daysOverdue: number | null; lastRemindedRel: string | null; balanceCents: number } {
  const balance = inv.totalCents - inv.amountPaidCents;
  const age = daysBetween(inv.createdAt, now);
  const daysOverdue =
    inv.state === 'open' && balance > 0 && age >= 30 ? age : null;
  const lastRemindedRel =
    inv.lastReminderSentAt ? rel(inv.lastReminderSentAt, now) : null;
  return { daysOverdue, lastRemindedRel, balanceCents: balance };
}

export function buildActivity(
  inv: Pick<InvoiceDetailView, 'createdAt' | 'lastReminderSentAt' | 'payments'>,
): ActivityEvent[] {
  const events: ActivityEvent[] = [];

  events.push({ kind: 'created', at: inv.createdAt, label: 'Invoice created' });

  for (const payment of inv.payments) {
    events.push({ kind: 'payment', at: payment.createdAt, label: 'Payment recorded' });
    for (const refund of payment.refunds ?? []) {
      events.push({ kind: 'refund', at: refund.createdAt, label: 'Refund issued' });
    }
  }

  if (inv.lastReminderSentAt) {
    events.push({ kind: 'reminder', at: inv.lastReminderSentAt, label: 'Reminder sent' });
  }

  return events.sort((a, b) => b.at.getTime() - a.at.getTime());
}
