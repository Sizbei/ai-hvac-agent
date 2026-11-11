'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Receipt } from 'lucide-react';
import { SectionCard } from '@/components/admin/ui/section-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { InvoiceStateBadge } from '@/components/admin/invoices/invoice-state-badge';
import { SyncPill } from '@/components/admin/sync-pill';
import { formatCentsExact } from '@/lib/admin/money-format';
import {
  PROFILE_LIST_PREVIEW,
  invoiceBalanceCents,
  previewRows,
  sharedSyncSource,
  summarizeInvoices,
} from '@/lib/admin/customer-money-summary';
import type { InvoiceListItem } from '@/hooks/use-invoices';

/** Enough for any one customer's lifetime; the header totals cover them all. */
const FETCH_LIMIT = 1000;

const SOURCE_NAME = { fieldpulse: 'FieldPulse', housecall: 'Housecall Pro' } as const;

function formatIssued(iso: string): string {
  // UTC-rendered: mirrored issue dates are UTC-pinned by parseFpDate, so
  // local-zone rendering would shift them a day back.
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function InvoiceRow({ inv, showPill }: { readonly inv: InvoiceListItem; readonly showPill: boolean }) {
  const balance = invoiceBalanceCents(inv);
  const partlyPaid = balance > 0 && balance < inv.totalCents;
  return (
    <Link
      href={`/admin/invoices/${inv.id}`}
      className="flex items-center gap-3 rounded-[3px] bg-surface-sunken px-3 py-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="min-w-[4.5rem] shrink-0">
        <InvoiceStateBadge state={inv.state} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
        {formatIssued(inv.issuedAt ?? inv.createdAt)}
      </span>
      {showPill && <SyncPill source={inv.syncedSource} size="sm" />}
      <span className="flex shrink-0 flex-col items-end">
        <span className="font-mono text-[13px] font-medium tabular-nums">
          {formatCentsExact(inv.totalCents)}
        </span>
        {partlyPaid && (
          <span className="font-mono text-[11px] tabular-nums text-warning">
            {formatCentsExact(balance)} due
          </span>
        )}
      </span>
    </Link>
  );
}

/**
 * The profile's Invoices card: lifetime billed and open balance in the
 * header, the newest invoices first, and Show all for long histories (an
 * imported customer can have 100+). Read-only; each row opens the invoice.
 */
export function CustomerInvoicesCard({ customerId }: { readonly customerId: string }) {
  const [invoices, setInvoices] = useState<readonly InvoiceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // Mounted with key={customerId}, so state starts fresh per customer.
    let active = true;
    const qs = new URLSearchParams({ limit: String(FETCH_LIMIT), customerId, sort: 'newest' });
    fetch(`/api/admin/invoices?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((body: { data: { invoices: InvoiceListItem[] } }) => {
        if (active) setInvoices(body.data.invoices);
      })
      .catch(() => {
        if (active) setError("Couldn't load invoices. Please try again.");
      });
    return () => {
      active = false;
    };
  }, [customerId]);

  const summary = invoices ? summarizeInvoices(invoices) : null;
  const shared = invoices ? sharedSyncSource(invoices) : null;
  const rows = invoices ? previewRows(invoices, expanded) : [];

  const description =
    summary && invoices && invoices.length > 0 ? (
      <span className="flex flex-wrap gap-x-4 gap-y-0.5">
        <span>
          Billed <span className="font-mono tabular-nums text-foreground">{formatCentsExact(summary.billedCents)}</span>
        </span>
        <span>
          Open balance{' '}
          <span
            className={`font-mono tabular-nums ${summary.openBalanceCents > 0 ? 'text-warning' : 'text-foreground'}`}
          >
            {formatCentsExact(summary.openBalanceCents)}
          </span>
          {summary.openCount > 0 && ` on ${summary.openCount} invoice${summary.openCount === 1 ? '' : 's'}`}
        </span>
        {shared && <span>Synced from {SOURCE_NAME[shared]}, read-only here</span>}
      </span>
    ) : undefined;

  return (
    <SectionCard
      title="Invoices"
      icon={Receipt}
      count={invoices ? invoices.length : undefined}
      description={description}
    >
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !invoices ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-[3px]" />
          ))}
        </div>
      ) : invoices.length === 0 ? (
        <p className="text-sm text-muted-foreground">No invoices yet.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((inv) => (
            <InvoiceRow key={inv.id} inv={inv} showPill={shared === null} />
          ))}
          {invoices.length > rows.length && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setExpanded(true)}>
              Show all {invoices.length.toLocaleString('en-US')} invoices
            </Button>
          )}
          {expanded && invoices.length > PROFILE_LIST_PREVIEW && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setExpanded(false)}>
              Show fewer
            </Button>
          )}
        </div>
      )}
    </SectionCard>
  );
}
