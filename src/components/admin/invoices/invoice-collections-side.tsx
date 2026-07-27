'use client';

import { formatCentsExact } from '@/lib/admin/money-format';
import { SectionCard } from '@/components/admin/ui/section-card';
import type { InvoiceDetailView, InvoiceReminderView } from '@/lib/admin/invoice-queries';
import { collectionsStats, buildActivity, type ActivityEvent } from './invoice-activity';

const KIND_LABEL: Record<ActivityEvent['kind'], string> = {
  created: 'Created',
  payment: 'Payment',
  refund: 'Refund',
  reminder: 'Reminder',
};

const KIND_DOT: Record<ActivityEvent['kind'], string> = {
  created: 'bg-info',
  payment: 'bg-success',
  refund: 'bg-warning',
  reminder: 'bg-primary',
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
      <SectionCard title="Collections">
        <div className="flex flex-col gap-2">
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
      </SectionCard>

      {/* Activity panel */}
      <SectionCard title="Activity">
        {activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">No activity yet.</p>
        ) : (
          <ol className="flex flex-col gap-3">
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
      </SectionCard>
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
