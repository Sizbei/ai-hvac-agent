'use client';
import { memo } from 'react';
import Link from 'next/link';
import type { InvoiceListItem } from '@/hooks/use-invoices';
import { formatCentsExact } from '@/lib/admin/money-format';
import { isCollectible, invoiceRef, canResend, REMINDER_COOLDOWN_MS } from '@/lib/admin/invoice-collectible';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
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

/** True while the 6h re-send cooldown is still active. */
function isCooldownActive(lastReminderSentAt: string | null): boolean {
  return !canResend(lastReminderSentAt, Date.now(), REMINDER_COOLDOWN_MS);
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
  readonly onCopyPayLink: (id: string) => void;
  readonly onVoid: (id: string) => void;
  readonly pending?: boolean;
}

function InvoiceRowInner({ invoice, onRemind, onCopyPayLink, onVoid, pending = false }: InvoiceRowProps) {
  const balance = invoice.totalCents - invoice.amountPaidCents;
  const isPartial = invoice.state !== 'paid' && invoice.amountPaidCents > 0;
  const cooldownActive = isCooldownActive(invoice.lastReminderSentAt ?? null);

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

      {/* Issued date (source-system date for mirrored invoices; row creation for native) */}
      <div className="text-xs text-muted-foreground">
        {new Date(invoice.issuedAt ?? invoice.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      </div>

      {/* Age chip */}
      <div>
        <AgeChip issuedAt={invoice.issuedAt} createdAt={invoice.createdAt} state={invoice.state} />
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
          !invoice.lastReminderSentAt ? (
            <Button size="sm" disabled={pending} onClick={() => onRemind(invoice.id)}>
              Send reminder
            </Button>
          ) : cooldownActive ? (
            <span className="inline-block rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-700">
              {`✓ Reminded ${remindedRel(invoice.lastReminderSentAt)}`}
            </span>
          ) : (
            <div className="flex items-center gap-1.5">
              <Button size="sm" disabled={pending} onClick={() => onRemind(invoice.id)}>
                Remind again
              </Button>
              <span className="text-xs text-muted-foreground">{`· last ${remindedRel(invoice.lastReminderSentAt)}`}</span>
            </div>
          )
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" aria-label="More actions" />}
          >
            <MoreHorizontal className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem render={<Link href={`/admin/invoices/${invoice.id}`} />}>
              View invoice
            </DropdownMenuItem>
            {invoice.syncedSource === null && (
              <DropdownMenuItem onClick={() => onCopyPayLink(invoice.id)}>
                Copy pay link
              </DropdownMenuItem>
            )}
            {invoice.syncedSource === null &&
              invoice.state !== 'paid' &&
              invoice.state !== 'void' &&
              invoice.state !== 'refunded' && (
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => onVoid(invoice.id)}
                >
                  Void invoice
                </DropdownMenuItem>
              )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export const InvoiceRow = memo(InvoiceRowInner);
