'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Receipt } from 'lucide-react';
import { InvoiceStateBadge } from '@/components/admin/invoices/invoice-state-badge';
import { formatCentsExact } from '@/lib/admin/money-format';
import type { InvoiceListItem } from '@/hooks/use-invoices';

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
 * Fetches server-filtered pages directly instead of pulling the full list
 * and filtering client-side.
 */
export function ScopedInvoicesSection({
  customerId,
  serviceRequestId,
  variant = 'card',
}: ScopedInvoicesSectionProps) {
  const [invoices, setInvoices] = useState<readonly InvoiceListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const scopeId = customerId ?? serviceRequestId;
    if (!scopeId) {
      setIsLoading(false);
      return;
    }

    let active = true;
    setIsLoading(true);
    setError(null);
    // Clear the previous scope's rows so the header count never flashes stale
    // while the new scope loads.
    setInvoices([]);

    const qs = new URLSearchParams({ limit: '200' });
    if (customerId) qs.set('customerId', customerId);
    else if (serviceRequestId) qs.set('serviceRequestId', serviceRequestId);

    fetch(`/api/admin/invoices?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((body: { success: boolean; data: { invoices: InvoiceListItem[] } }) => {
        if (active) setInvoices(body.data.invoices);
      })
      .catch(() => {
        if (active) setError('Could not load invoices.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [customerId, serviceRequestId]);

  const body = isLoading ? (
    <p className="text-sm text-muted-foreground">Loading…</p>
  ) : error ? (
    <p className="text-sm text-destructive">{error}</p>
  ) : invoices.length === 0 ? (
    <p className="text-sm text-muted-foreground">No invoices yet.</p>
  ) : (
    <div className="space-y-2">
      {invoices.map((inv) => (
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
          Invoices ({invoices.length})
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
          Invoices ({invoices.length})
        </h3>
      </div>
      <div className="p-4 pt-2">{body}</div>
    </div>
  );
}
