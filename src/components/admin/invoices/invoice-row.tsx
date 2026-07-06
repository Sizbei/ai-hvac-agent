'use client';
import Link from 'next/link';
import type { InvoiceListItem } from '@/hooks/use-invoices';
import { formatCentsExact } from '@/lib/admin/money-format';
import { isCollectible, invoiceRef } from '@/lib/admin/invoice-collectible';
import { Button } from '@/components/ui/button';
import { AgeChip, daysBetween } from './age-chip';

/** Stable hue from a string id — deterministic avatar colour. */
function avatarHue(id: string): string {
  const HUES = [
    'bg-blue-600', 'bg-teal-600', 'bg-violet-600', 'bg-sky-600',
    'bg-emerald-600', 'bg-slate-600', 'bg-purple-600', 'bg-amber-600',
  ];
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[h % HUES.length];
}

/** Two-letter initials from a display name. */
function initials(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Relative time label for lastReminderSentAt. */
function remindedRel(iso: string): string {
  const days = daysBetween(new Date(iso), new Date());
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

interface InvoiceRowProps {
  readonly invoice: InvoiceListItem;
  readonly onRemind: (id: string) => void;
  readonly pending?: boolean;
}

export function InvoiceRow({ invoice, onRemind, pending = false }: InvoiceRowProps) {
  const balance = invoice.totalCents - invoice.amountPaidCents;
  const isPartial = invoice.state !== 'paid' && invoice.amountPaidCents > 0;

  return (
    <div className="grid grid-cols-[minmax(200px,1fr)_90px_120px_140px_180px] items-center gap-4 border-t px-6 py-4 transition-colors hover:bg-muted/30 first:border-t-0">
      {/* Customer */}
      <div className="flex min-w-0 items-center gap-3">
        <span
          className={`inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white ${avatarHue(invoice.id)}`}
        >
          {initials(invoice.customerName)}
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {invoice.customerName ?? '—'}
          </p>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{invoiceRef(invoice.id)}</span>
            {invoice.syncedSource && (
              <span className="rounded border bg-violet-50 px-1.5 py-px text-[10px] font-medium text-violet-700">
                {invoice.syncedSource === 'fieldpulse' ? 'FieldPulse' : 'Housecall Pro'}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Created date */}
      <div className="text-xs text-muted-foreground">
        {new Date(invoice.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      </div>

      {/* Age chip */}
      <div>
        <AgeChip createdAt={invoice.createdAt} state={invoice.state} />
      </div>

      {/* Balance */}
      <div className="text-right">
        <p className="text-sm font-bold tabular-nums">
          {invoice.state === 'paid' ? formatCentsExact(invoice.totalCents) : formatCentsExact(balance)}
        </p>
        {isPartial && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            of {formatCentsExact(invoice.totalCents)}
          </p>
        )}
      </div>

      {/* Action rail */}
      <div className="flex items-center justify-end gap-2">
        {isCollectible(invoice) && invoice.syncedSource === null ? (
          invoice.lastReminderSentAt ? (
            <span className="inline-block rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-700">
              {`✓ Reminded ${remindedRel(invoice.lastReminderSentAt)}`}
            </span>
          ) : (
            <Button size="sm" disabled={pending} onClick={() => onRemind(invoice.id)}>
              Send reminder
            </Button>
          )
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
        <Link href={`/admin/invoices/${invoice.id}`}>
          <Button variant="outline" size="sm">
            View
          </Button>
        </Link>
      </div>
    </div>
  );
}
