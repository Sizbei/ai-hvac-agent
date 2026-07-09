'use client';

import Link from 'next/link';
import { Receipt } from 'lucide-react';
import { useInvoices } from '@/hooks/use-invoices';
import { InvoiceStateBadge } from '@/components/admin/invoices/invoice-state-badge';
import { formatCentsExact } from '@/lib/admin/money-format';

interface ScopedInvoicesSectionProps {
  /** Exactly one of these scopes the list. */
  readonly customerId?: string;
  readonly serviceRequestId?: string;
  /** Render style: 'card' for full-card pages, 'plain' for the request sheet. */
  readonly variant?: 'card' | 'plain';
}

function formatDate(iso: string): string {
  // UTC-rendered: mirrored issue dates are UTC-pinned by parseFpDate, so
  // local-zone rendering would shift them a day back.
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * Thin read-only list of invoices scoped to a customer or service request.
 * Read-only (creation happens from a sold estimate). Reuses useInvoices and
 * filters client-side (invoice volume per entity is small).
 */
export function ScopedInvoicesSection({
  customerId,
  serviceRequestId,
  variant = 'card',
}: ScopedInvoicesSectionProps) {
  const { invoices, isLoading } = useInvoices();

  const scoped = invoices.filter((i) =>
    serviceRequestId
      ? i.serviceRequestId === serviceRequestId
      : i.customerId === customerId,
  );

  const body = isLoading ? (
    <p className="text-sm text-muted-foreground">Loading…</p>
  ) : scoped.length === 0 ? (
    <p className="text-sm text-muted-foreground">No invoices yet.</p>
  ) : (
    <div className="space-y-2">
      {scoped.map((inv) => (
        <Link
          key={inv.id}
          href={`/admin/invoices/${inv.id}`}
          className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/30"
        >
          <div className="flex items-center gap-3">
            <InvoiceStateBadge state={inv.state} />
            {inv.syncedSource && (
              <span className="rounded-full border bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700">
                {inv.syncedSource === 'fieldpulse' ? 'FieldPulse' : 'Housecall Pro'}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {formatDate(inv.issuedAt ?? inv.createdAt)}
            </span>
          </div>
          <span className="text-sm font-medium">
            {formatCentsExact(inv.totalCents)}
          </span>
        </Link>
      ))}
    </div>
  );

  if (variant === 'plain') {
    return (
      <div className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Receipt className="size-4" />
          Invoices ({scoped.length})
        </h3>
        {body}
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between p-4 pb-2">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <Receipt className="size-4" />
          Invoices ({scoped.length})
        </h3>
      </div>
      <div className="p-4 pt-2">{body}</div>
    </div>
  );
}
