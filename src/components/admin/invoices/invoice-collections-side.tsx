'use client';

import { formatCentsExact } from '@/lib/admin/money-format';
import type { InvoiceDetailView, InvoiceReminderView } from '@/lib/admin/invoice-queries';
import { collectionsStats, buildActivity, type ActivityEvent } from './invoice-activity';

const KIND_LABEL: Record<ActivityEvent['kind'], string> = {
  created: 'Created',
  payment: 'Payment',
  refund: 'Refund',
  reminder: 'Reminder',
};

const KIND_DOT: Record<ActivityEvent['kind'], string> = {
  created: 'bg-sky-500',
  payment: 'bg-emerald-500',
  refund: 'bg-amber-500',
  reminder: 'bg-violet-500',
};

export function InvoiceCollectionsSide({
  invoice,
  reminders = [],
}: {
  invoice: InvoiceDetailView;
  reminders?: InvoiceReminderView[];
}) {
  const now = new Date();
  const { daysOverdue, lastRemindedRel, balanceCents } = collectionsStats(invoice, now);
  const activity = buildActivity(invoice, reminders);

  return (
    <div className="flex flex-col gap-4">
      {/* Collections panel */}
      <div className="rounded-xl border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Collections
        </p>

        <div className="mt-3 flex flex-col gap-2">
          <Row label="Balance due" value={formatCentsExact(balanceCents)} />
          <Row
            label="Days overdue"
            value={daysOverdue !== null ? `${daysOverdue}d` : '—'}
            valueClassName={daysOverdue !== null ? 'text-destructive font-semibold' : ''}
          />
          <Row
            label="Reminders sent"
            value={String(reminders.length || (invoice.lastReminderSentAt ? 1 : 0))}
          />
          <Row label="Last reminder" value={lastRemindedRel ?? '—'} />
        </div>
      </div>

      {/* Activity panel */}
      <div className="rounded-xl border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Activity
        </p>

        {activity.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <ol className="mt-3 flex flex-col gap-3">
            {activity.map((ev, i) => (
              <li key={ev.at.toISOString() + ev.kind + i} className="flex items-start gap-2.5">
                <span
                  className={`mt-1 size-2 shrink-0 rounded-full ${KIND_DOT[ev.kind]}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium leading-none">{ev.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {KIND_LABEL[ev.kind]} · {ev.at.toLocaleDateString()}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  valueClassName = '',
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`text-sm tabular-nums ${valueClassName}`}>{value}</span>
    </div>
  );
}
