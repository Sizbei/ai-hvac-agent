'use client';
import { memo } from 'react';
import Link from 'next/link';
import type { InvoiceListItem } from '@/hooks/use-invoices';
import { formatCentsExact } from '@/lib/admin/money-format';
import { isCollectible, invoiceRef, canResend, REMINDER_COOLDOWN_MS } from '@/lib/admin/invoice-collectible';
import { CheckCircle, ChevronDown, ChevronRight, MoreHorizontal } from 'lucide-react';
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
import { canSendReminder, invoiceLinkAction } from '@/lib/admin/invoice-payment-copy';
import { shortIssuedDate } from '@/lib/admin/invoice-dates';

/**
 * Shared header/row grid. Phone: customer (with its age under it), balance,
 * chevron — the one number a collector needs stays on screen; the actions
 * live in the expanded panel and on the invoice. From `sm` up: the full
 * six-column table.
 */
export const INVOICE_ROW_GRID =
  'grid-cols-[minmax(0,1fr)_auto_24px] sm:grid-cols-[minmax(200px,1fr)_90px_120px_140px_232px_32px]';
/** Header columns hidden below `sm`. */
export const INVOICE_ROW_DESKTOP_ONLY: ReadonlySet<string> = new Set(['created', 'age', 'actions']);

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
  readonly cardPaymentsEnabled: boolean;
  readonly pending?: boolean;
  readonly isExpanded: boolean;
  readonly onToggle: (id: string) => void;
}

function InvoiceRowInner({ invoice, onRemind, onCopyPayLink, onVoid, cardPaymentsEnabled, pending = false, isExpanded, onToggle }: InvoiceRowProps) {
  const linkAction = invoiceLinkAction({
    state: invoice.state,
    syncedSource: invoice.syncedSource,
    customerId: invoice.customerId,
    cardPaymentsEnabled,
  });
  const showReminder = canSendReminder({
    collectible: isCollectible(invoice),
    syncedSource: invoice.syncedSource,
    customerId: invoice.customerId,
  });
  const balance = invoice.totalCents - invoice.amountPaidCents;
  const shownCents = invoice.state === 'paid' ? invoice.totalCents : balance;
  const isPartial = invoice.state !== 'paid' && invoice.amountPaidCents > 0;
  const cooldownActive = isCooldownActive(invoice.lastReminderSentAt ?? null);

  return (
    <>
      {/* Row toggle — the entire row is clickable, but dropdown/buttons stop propagation */}
      {/* role="button" (not <button>): the action rail below contains real
          <button>s, and a button-in-button is invalid HTML + a hydration error. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        onClick={() => onToggle(invoice.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(invoice.id);
          }
        }}
        className={`grid ${INVOICE_ROW_GRID} items-center gap-4 border-t border-border px-4 py-2.5 transition-colors hover:bg-row-hover first:border-t-0 w-full text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`}
      >
        {/* Customer — name over its mono invoice ref. The initials tile that
            used to lead this cell carried no information the name beside it
            didn't, and it pushed the first cell off the gutter every other
            panel on the page shares. */}
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">
            {invoice.customerName ?? '—'}
          </p>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="font-mono tabular-nums">{invoiceRef(invoice.id)}</span>
            {invoice.syncedSource && (
              <SyncPill source={invoice.syncedSource} size="md" />
            )}
          </div>
          {/* Phone: the age column is hidden, so its chip rides under the name. */}
          <div className="mt-1 sm:hidden">
            <AgeChip issuedAt={invoice.issuedAt} dueDate={invoice.dueDate} createdAt={invoice.createdAt} state={invoice.state} />
          </div>
        </div>

        {/* Issued date (source-system date for mirrored invoices; row creation
            for native). UTC-rendered: the source dates are UTC-pinned by
            parseFpDate, so local-zone rendering would shift them a day back. */}
        <div className="hidden font-mono text-xs tabular-nums text-muted-foreground sm:block">
          {shortIssuedDate(invoice.issuedAt ?? invoice.createdAt)}
        </div>

        {/* Age chip */}
        <div className="hidden sm:block">
          <AgeChip issuedAt={invoice.issuedAt} dueDate={invoice.dueDate} createdAt={invoice.createdAt} state={invoice.state} />
        </div>

        {/* Balance — right-aligned tabular mono; a zero balance recedes. */}
        <div className="text-right">
          <p
            className={`font-mono text-sm font-medium tabular-nums ${
              shownCents === 0 ? 'text-muted-foreground' : 'text-foreground'
            }`}
          >
            {formatCentsExact(shownCents)}
          </p>
          {isPartial && (
            <p className="mt-0.5 font-mono text-xs tabular-nums text-muted-foreground">
              of {formatCentsExact(invoice.totalCents)}
            </p>
          )}
        </div>

        {/* Action rail — stopPropagation so clicks don't toggle expansion.
            Fixed-width, right-aligned and nowrap: whatever state a row is in
            (button / reminded pill / em-dash), its control ends on the same
            right edge, just left of the ⋯ trigger. The "last …" meta therefore
            sits BEFORE the button on one line — rendered after it, it wrapped
            to two ragged lines and shoved the button ~50 px left of every
            other row's. */}
        <div
          className="hidden items-center justify-end gap-2 whitespace-nowrap sm:flex"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {showReminder ? (
            !invoice.lastReminderSentAt ? (
              <Button size="sm" disabled={pending} onClick={(e) => { e.stopPropagation(); onRemind(invoice.id); }}>
                Send reminder
              </Button>
            ) : cooldownActive ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-[3px] px-2 py-1 text-xs font-medium text-success-strong">
                <CheckCircle className="size-3.5" aria-hidden="true" />
                {`Reminded ${remindedRel(invoice.lastReminderSentAt)}`}
              </span>
            ) : (
              <>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {`last ${remindedRel(invoice.lastReminderSentAt)}`}
                </span>
                <Button size="sm" disabled={pending} onClick={(e) => { e.stopPropagation(); onRemind(invoice.id); }}>
                  Remind again
                </Button>
              </>
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
              {linkAction && (
                <DropdownMenuItem onClick={() => onCopyPayLink(invoice.id)}>
                  {linkAction.label}
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
      </div>

      {/* Expansion panel — no border-t so it reads as one unit with its row;
          the NEXT row's border-t separates it from what follows. */}
      {isExpanded && (
        <div className="bg-surface-sunken px-4 py-4 animate-in fade-in-0 slide-in-from-top-1 duration-100 motion-reduce:animate-none">
          <div className="flex flex-wrap gap-6">
            {/* Key facts */}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
              <dt className="text-muted-foreground">Status</dt>
              <dd><InvoiceStateBadge state={invoice.state} /></dd>

              <dt className="text-muted-foreground">Issued</dt>
              <dd className="font-mono tabular-nums">
                {invoice.issuedAt
                  ? new Date(invoice.issuedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
                  : new Date(invoice.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </dd>

              {invoice.dueDate && (
                <>
                  <dt className="text-muted-foreground">Due</dt>
                  <dd className="font-mono tabular-nums">
                    {new Date(invoice.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}
                  </dd>
                </>
              )}

              <dt className="text-muted-foreground">Total</dt>
              <dd className="text-right font-mono font-medium tabular-nums">{formatCentsExact(invoice.totalCents)}</dd>

              <dt className="text-muted-foreground">Paid</dt>
              <dd className={`text-right font-mono tabular-nums ${invoice.amountPaidCents === 0 ? 'text-muted-foreground' : ''}`}>{formatCentsExact(invoice.amountPaidCents)}</dd>

              <dt className="text-muted-foreground">Balance</dt>
              <dd className={`text-right font-mono font-medium tabular-nums ${balance === 0 ? 'text-muted-foreground' : ''}`}>{formatCentsExact(balance)}</dd>
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
