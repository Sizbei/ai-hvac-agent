'use client';
import { memo } from 'react';
import Link from 'next/link';
import type { InvoiceListItem } from '@/hooks/use-invoices';
import { formatCentsExact } from '@/lib/admin/money-format';
import { isCollectible, invoiceRef, canResend, REMINDER_COOLDOWN_MS } from '@/lib/admin/invoice-collectible';
import { ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { AgeChip, daysBetween } from './age-chip';
import { SyncPill } from '@/components/admin/sync-pill';
import { InvoiceStateBadge } from './invoice-state-badge';
import { FieldpulseDetails } from '@/components/admin/fieldpulse-details';

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
  readonly isExpanded: boolean;
  readonly onToggle: (id: string) => void;
}

function InvoiceRowInner({ invoice, onRemind, onCopyPayLink, onVoid, pending = false, isExpanded, onToggle }: InvoiceRowProps) {
  const balance = invoice.totalCents - invoice.amountPaidCents;
  const isPartial = invoice.state !== 'paid' && invoice.amountPaidCents > 0;
  const cooldownActive = isCooldownActive(invoice.lastReminderSentAt ?? null);

  return (
    <>
      {/* Row toggle — the entire row is clickable, but dropdown/buttons stop propagation */}
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={() => onToggle(invoice.id)}
        className="grid grid-cols-[minmax(200px,1fr)_90px_120px_140px_180px_32px] items-center gap-4 border-t px-6 py-4 transition-colors hover:bg-muted/30 first:border-t-0 w-full text-left"
      >
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
                <SyncPill source={invoice.syncedSource} size="md" />
              )}
            </div>
          </div>
        </div>

        {/* Issued date (source-system date for mirrored invoices; row creation
            for native). UTC-rendered: the source dates are UTC-pinned by
            parseFpDate, so local-zone rendering would shift them a day back. */}
        <div className="text-xs text-muted-foreground">
          {new Date(invoice.issuedAt ?? invoice.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}
        </div>

        {/* Age chip */}
        <div>
          <AgeChip issuedAt={invoice.issuedAt} dueDate={invoice.dueDate} createdAt={invoice.createdAt} state={invoice.state} />
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

        {/* Action rail — stopPropagation so clicks don't toggle expansion */}
        <div
          className="flex items-center justify-end gap-2"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {isCollectible(invoice) && invoice.syncedSource === null ? (
            !invoice.lastReminderSentAt ? (
              <Button size="sm" disabled={pending} onClick={(e) => { e.stopPropagation(); onRemind(invoice.id); }}>
                Send reminder
              </Button>
            ) : cooldownActive ? (
              <span className="inline-block rounded-lg px-2.5 py-1.5 text-xs font-semibold text-emerald-700">
                {`✓ Reminded ${remindedRel(invoice.lastReminderSentAt)}`}
              </span>
            ) : (
              <div className="flex items-center gap-1.5">
                <Button size="sm" disabled={pending} onClick={(e) => { e.stopPropagation(); onRemind(invoice.id); }}>
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
              onClick={(e) => e.stopPropagation()}
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

        {/* Chevron */}
        <div className="flex items-center justify-center text-muted-foreground" aria-hidden="true">
          {isExpanded
            ? <ChevronDown className="size-4" />
            : <ChevronRight className="size-4" />
          }
        </div>
      </button>

      {/* Expansion panel — no border-t so it reads as one unit with its row;
          the NEXT row's border-t separates it from what follows. */}
      {isExpanded && (
        <div className="bg-muted/30 px-6 py-4 animate-in fade-in-0 slide-in-from-top-1 duration-100">
          <div className="flex flex-wrap gap-6">
            {/* Key facts */}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Status</dt>
              <dd><InvoiceStateBadge state={invoice.state} /></dd>

              <dt className="text-muted-foreground">Issued</dt>
              <dd className="tabular-nums">
                {invoice.issuedAt
                  ? new Date(invoice.issuedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
                  : new Date(invoice.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </dd>

              {invoice.dueDate && (
                <>
                  <dt className="text-muted-foreground">Due</dt>
                  <dd className="tabular-nums">
                    {new Date(invoice.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
                  </dd>
                </>
              )}

              <dt className="text-muted-foreground">Total</dt>
              <dd className="font-medium tabular-nums">{formatCentsExact(invoice.totalCents)}</dd>

              <dt className="text-muted-foreground">Paid</dt>
              <dd className="tabular-nums">{formatCentsExact(invoice.amountPaidCents)}</dd>

              <dt className="text-muted-foreground">Balance</dt>
              <dd className="font-semibold tabular-nums">{formatCentsExact(balance)}</dd>
            </dl>

            {/* FieldPulse details */}
            {invoice.fieldpulseData && (
              <div className="flex-1 min-w-48">
                <FieldpulseDetails data={invoice.fieldpulseData} />
              </div>
            )}
          </div>

          {/* Primary action */}
          <div className="mt-4">
            <Link href={`/admin/invoices/${invoice.id}`}>
              <Button variant="outline" size="sm">
                Open invoice →
              </Button>
            </Link>
          </div>
        </div>
      )}
    </>
  );
}

export const InvoiceRow = memo(InvoiceRowInner);
