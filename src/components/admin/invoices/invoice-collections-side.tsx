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
        <div className="flex flex-col">
          <Row label="Balance due" value={formatCentsExact(balanceCents)} />
          <Row
            label="Days overdue"
            value={daysOverdue !== null ? `${daysOverdue}d` : '—'}
            valueClassName={daysOverdue !== null ? 'text-danger-strong font-medium' : ''}
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
                  aria-hidden="true"
                  className={`mt-1 size-1.5 shrink-0 rounded-[1px] ${KIND_DOT[ev.kind]}`}
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
  // Ruled definition row: 140 px label, value right, hairline per pair.
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border py-2 last:border-b-0 last:pb-0">
      <span className="w-[140px] shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span className={`text-right font-mono text-[13px] tabular-nums ${valueClassName}`}>
        {value}
      </span>
    </div>
  );
}
