'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EstimateStatusBadge } from '@/components/admin/estimates/estimate-status-badge';
import { FinancingPanel } from '@/components/admin/financing/financing-panel';
import { formatCentsExact } from '@/lib/admin/money-format';
import { rollUpMargin } from '@/lib/admin/margin';
import { FieldpulseDetails } from '@/components/admin/fieldpulse-details';
import { SyncPill } from '@/components/admin/sync-pill';

interface LineItem {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly costCents: number;
  readonly lineTotalCents: number;
}
interface Option {
  readonly id: string;
  readonly name: string;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly lineItems: LineItem[];
}
interface EstimateDetail {
  readonly id: string;
  readonly status: string;
  readonly totalCents: number;
  readonly customerId: string | null;
  readonly serviceRequestId: string | null;
  readonly soldOptionId: string | null;
  readonly signatureName: string | null;
  readonly signedAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly dueDate: string | null;
  readonly options: Option[];
  readonly syncedSource: 'fieldpulse' | null;
  readonly fieldpulseStatusName: string | null;
  readonly title: string | null;
  readonly fieldpulseData: Record<string, unknown> | null;
}

export default function EstimateDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [estimate, setEstimate] = useState<EstimateDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedOption, setSelectedOption] = useState<string>('');
  const [isMarking, setIsMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [isInvoicing, setIsInvoicing] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/admin/estimates/${id}`);
      if (!res.ok) {
        setError(res.status === 404 ? 'Estimate not found' : 'Failed to load');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { estimate: EstimateDetail };
      };
      if (body.success) {
        setEstimate(body.data.estimate);
        setSelectedOption(body.data.estimate.options[0]?.id ?? '');
        setError(null);
      }
    } catch {
      setError('Could not connect to server.');
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleMarkSold = useCallback(async (): Promise<void> => {
    if (!selectedOption) return;
    setIsMarking(true);
    setMarkError(null);
    try {
      const res = await fetch(`/api/admin/estimates/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ optionId: selectedOption }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        void load();
      } else {
        setMarkError(body.error?.message ?? 'Failed to mark sold');
      }
    } catch {
      setMarkError('Could not connect to server.');
    } finally {
      setIsMarking(false);
    }
  }, [id, selectedOption, load]);

  const handleGenerateInvoice = useCallback(async (): Promise<void> => {
    setIsInvoicing(true);
    setInvoiceError(null);
    try {
      const res = await fetch('/api/admin/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: id }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      // Idempotent: an existing invoice is returned (not an error), so on success
      // we always have an invoiceId to navigate to.
      if (res.ok && body.success && body.data?.invoiceId) {
        router.push(`/admin/invoices/${body.data.invoiceId}`);
      } else {
        setInvoiceError(body.error?.message ?? 'Failed to generate invoice');
        setIsInvoicing(false);
      }
    } catch {
      setInvoiceError('Could not connect to server.');
      setIsInvoicing(false);
    }
  }, [id, router]);

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error || !estimate) {
    return (
      <div className="py-12 text-center">
        <p className="text-muted-foreground">{error ?? 'Estimate not found'}</p>
        <Link href="/admin/estimates">
          <Button variant="outline" className="mt-4">
            Back to Estimates
          </Button>
        </Link>
      </div>
    );
  }

  const isOpen = estimate.status === 'open';
  const isSynced = estimate.syncedSource === 'fieldpulse';

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/estimates">
          <Button variant="ghost" size="icon-sm">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {estimate.title ?? 'Estimate'}
          </h1>
          <p className="text-sm text-muted-foreground">
            Created {new Date(estimate.createdAt).toLocaleDateString()}
            {estimate.dueDate && (
              <> · Due {new Date(estimate.dueDate).toLocaleDateString()}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <EstimateStatusBadge status={estimate.status} />
          {isSynced && estimate.fieldpulseStatusName && (
            <span className="text-[11px] text-muted-foreground ml-1">({estimate.fieldpulseStatusName})</span>
          )}
          {isSynced && (
            <SyncPill source={estimate.syncedSource} size="md" />
          )}
        </div>
      </div>

      {/* ── Synced source banner ── */}
      {isSynced && (
        <div className="rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 text-sm text-violet-900">
          Synced from FieldPulse — estimates are managed there.
        </div>
      )}

      {(estimate.customerId || estimate.serviceRequestId) && (
        <div className="flex gap-4 text-sm">
          {estimate.customerId && (
            <Link
              href={`/admin/customers/${estimate.customerId}`}
              className="text-primary hover:underline"
            >
              View customer
            </Link>
          )}
          {estimate.serviceRequestId && (
            <Link
              href={`/admin/requests?request=${estimate.serviceRequestId}`}
              className="text-primary hover:underline"
            >
              View request
            </Link>
          )}
        </div>
      )}

      {/* Options */}
      {estimate.options.map((opt) => {
        const isSold = estimate.soldOptionId === opt.id;
        const margin = rollUpMargin(opt.lineItems);
        return (
          <Card key={opt.id} className={isSold ? 'border-green-400' : undefined}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>
                  {opt.name}
                  {isSold && (
                    <span className="ml-2 text-xs font-medium text-green-700">
                      (sold)
                    </span>
                  )}
                </span>
                <span>{formatCentsExact(opt.totalCents)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1.5">
                {opt.lineItems.map((li) => (
                  <li key={li.id} className="flex justify-between text-sm">
                    <span className="text-muted-foreground">
                      {li.name}
                      {li.quantity > 1 ? ` × ${li.quantity}` : ''}
                    </span>
                    <span>{formatCentsExact(li.lineTotalCents)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 space-y-1 border-t pt-3 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span>{formatCentsExact(opt.subtotalCents)}</span>
                </div>
                {opt.taxCents > 0 && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>Tax</span>
                    <span>{formatCentsExact(opt.taxCents)}</span>
                  </div>
                )}
              </div>

              {/* Internal margin readout (admin-only; subordinate styling). */}
              <div className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <div className="mb-1 font-medium uppercase tracking-wide text-[10px]">
                  Margin (internal)
                </div>
                <div className="flex justify-between">
                  <span>Revenue</span>
                  <span className="tabular-nums">
                    {formatCentsExact(margin.revenueCents)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Cost</span>
                  <span className="tabular-nums">
                    {formatCentsExact(margin.costCents)}
                  </span>
                </div>
                <div className="flex justify-between font-medium text-foreground">
                  <span>Margin</span>
                  <span className="tabular-nums">
                    {formatCentsExact(margin.marginCents)} (
                    {(margin.marginPct * 100).toFixed(1)}%)
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Signature info if signed */}
      {estimate.signedAt && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approval</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Signed by{' '}
            <span className="font-medium text-foreground">
              {estimate.signatureName ?? 'customer'}
            </span>{' '}
            on {new Date(estimate.signedAt).toLocaleString()}.
          </CardContent>
        </Card>
      )}

      {/* Generate invoice — only once sold; never for synced estimates */}
      {estimate.status === 'sold' && !isSynced && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Invoice</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Generate an invoice from the sold option to take payment.
            </p>
            <Button
              size="sm"
              disabled={isInvoicing}
              onClick={handleGenerateInvoice}
            >
              <Receipt className="mr-2 size-4" />
              {isInvoicing ? 'Generating…' : 'Generate invoice'}
            </Button>
            {invoiceError && (
              <p className="text-xs text-destructive">{invoiceError}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Financing (subordinate) — once sold, offer the customer a lender
          prequalification link for the sold option's total. */}
      {estimate.status === 'sold' &&
        (() => {
          const soldOption = estimate.options.find(
            (o) => o.id === estimate.soldOptionId,
          );
          const amountCents = soldOption?.totalCents ?? estimate.totalCents;
          return amountCents > 0 ? (
            <FinancingPanel
              estimateId={estimate.id}
              requestedAmountCents={amountCents}
            />
          ) : null;
        })()}

      {/* Mark sold (admin path) — only while open and not synced */}
      {isOpen && !isSynced && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Mark sold</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Record a verbal acceptance by selecting the won option.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Estimate option to mark sold"
                value={selectedOption}
                onChange={(e) => setSelectedOption(e.target.value)}
                className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {estimate.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} — {formatCentsExact(o.totalCents)}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                disabled={isMarking || !selectedOption}
                onClick={handleMarkSold}
              >
                {isMarking ? 'Saving…' : 'Mark sold'}
              </Button>
            </div>
            {markError && <p className="text-xs text-destructive">{markError}</p>}
          </CardContent>
        </Card>
      )}

      {/* FieldPulse spillover details — collapsed by default; hidden when null */}
      <FieldpulseDetails data={estimate.fieldpulseData} />
    </div>
  );
}
