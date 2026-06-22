'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { InvoiceStateBadge } from '@/components/admin/invoices/invoice-state-badge';
import { FinancingPanel } from '@/components/admin/financing/financing-panel';
import { formatCentsExact, parseDollarsToCents } from '@/lib/admin/money-format';
import { rollUpMargin, computeMargin } from '@/lib/admin/margin';
import { deriveInvoicePresentation } from '@/lib/admin/invoice-presentation';

interface LineItem {
  readonly id: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceCents: number;
  readonly costCents: number;
  readonly lineTotalCents: number;
}
interface Refund {
  readonly id: string;
  readonly amountCents: number;
  readonly reason: string | null;
  readonly createdAt: string;
}
interface Payment {
  readonly id: string;
  readonly amountCents: number;
  readonly status: string;
  readonly isDeposit: boolean;
  readonly createdAt: string;
  readonly refunds: Refund[];
}
interface InvoiceDetail {
  readonly id: string;
  readonly state: string;
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly totalCents: number;
  readonly amountPaidCents: number;
  readonly customerId: string | null;
  readonly serviceRequestId: string | null;
  readonly estimateId: string | null;
  readonly createdAt: string;
  readonly syncedSource: 'fieldpulse' | 'housecall' | null;
  readonly lineItems: LineItem[];
  readonly payments: Payment[];
  readonly actualMaterialsCostCents: number | null;
  readonly actualLaborCostCents: number | null;
}

const REFUND_REASONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'duplicate', label: 'Duplicate charge' },
  { value: 'customer_request', label: 'Customer request' },
  { value: 'defective', label: 'Defective / service issue' },
  { value: 'other', label: 'Other' },
];

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function InvoiceDetailClient({
  id,
  canRefund,
}: {
  readonly id: string;
  readonly canRefund: boolean;
}) {
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Take-payment form
  const [payAmount, setPayAmount] = useState('');
  const [isDeposit, setIsDeposit] = useState(false);
  const [isPaying, setIsPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);

  // Refund: which payment is being refunded + form state
  const [refundFor, setRefundFor] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('customer_request');
  const [isRefunding, setIsRefunding] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/admin/invoices/${id}`);
      if (!res.ok) {
        setError(res.status === 404 ? 'Invoice not found' : 'Failed to load');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { invoice: InvoiceDetail };
      };
      if (body.success) {
        setInvoice(body.data.invoice);
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

  const handleTakePayment = useCallback(async (): Promise<void> => {
    const amountCents = parseDollarsToCents(payAmount);
    if (amountCents < 1) {
      setPayError('Enter an amount greater than zero.');
      return;
    }
    setIsPaying(true);
    setPayError(null);
    try {
      const res = await fetch(`/api/admin/invoices/${id}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountCents, isDeposit }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setPayAmount('');
        setIsDeposit(false);
        void load();
      } else {
        setPayError(body.error?.message ?? 'Failed to take payment');
      }
    } catch {
      setPayError('Could not connect to server.');
    } finally {
      setIsPaying(false);
    }
  }, [id, payAmount, isDeposit, load]);

  const handleRefund = useCallback(
    async (paymentId: string): Promise<void> => {
      const amountCents = parseDollarsToCents(refundAmount);
      if (amountCents < 1) {
        setRefundError('Enter an amount greater than zero.');
        return;
      }
      setIsRefunding(true);
      setRefundError(null);
      try {
        const res = await fetch(`/api/admin/payments/${paymentId}/refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountCents, reason: refundReason }),
        });
        const body = await res.json().catch(() => ({ success: false }));
        if (res.ok && body.success) {
          setRefundFor(null);
          setRefundAmount('');
          setRefundReason('customer_request');
          void load();
        } else {
          setRefundError(body.error?.message ?? 'Failed to refund');
        }
      } catch {
        setRefundError('Could not connect to server.');
      } finally {
        setIsRefunding(false);
      }
    },
    [refundAmount, refundReason, load],
  );

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error || !invoice) {
    return (
      <div className="py-12 text-center">
        <p className="text-muted-foreground">{error ?? 'Invoice not found'}</p>
        <Link href="/admin/invoices">
          <Button variant="outline" className="mt-4">
            Back to Invoices
          </Button>
        </Link>
      </div>
    );
  }

  // Derived display/affordance state (pure, unit-tested in invoice-presentation).
  // Read-only mirror from an FSM (FieldPulse / Housecall Pro): money is managed
  // there, so native pay/refund controls are hidden and a caveat is shown.
  const { balanceCents: balance, canTakePayment, sourceLabel } =
    deriveInvoicePresentation(invoice);
  // Margin is line revenue vs snapshotted line cost (excludes tax — tax is not
  // revenue). Internal/admin-only readout.
  const margin = rollUpMargin(invoice.lineItems);
  // Actual field costs the tech recorded on the linked job (if any): materials
  // used + labor logged (clocked time × snapshotted rate). Shown ALONGSIDE the
  // estimated figure — never overwriting it. The actual margin recomputes
  // revenue minus actual materials minus actual labor (each shown as its own
  // line; absent ones count as 0 so they're not double-counted).
  const actualMaterialsCostCents = invoice.actualMaterialsCostCents;
  const actualLaborCostCents = invoice.actualLaborCostCents;
  const hasActual =
    actualMaterialsCostCents !== null || actualLaborCostCents !== null;
  const actualTotalCostCents =
    (actualMaterialsCostCents ?? 0) + (actualLaborCostCents ?? 0);
  const actualMargin = hasActual
    ? computeMargin(margin.revenueCents, actualTotalCostCents)
    : null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/admin/invoices">
          <Button variant="ghost" size="icon-sm">
            <ArrowLeft className="size-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold tracking-tight">Invoice</h1>
          <p className="text-sm text-muted-foreground">
            Created {new Date(invoice.createdAt).toLocaleDateString()}
          </p>
        </div>
        {sourceLabel && (
          <span className="rounded-full border bg-violet-50 px-2.5 py-0.5 text-xs font-medium text-violet-700">
            {sourceLabel}
          </span>
        )}
        <InvoiceStateBadge state={invoice.state} />
      </div>

      {sourceLabel && (
        <div className="rounded-md border border-violet-200 bg-violet-50/60 px-3 py-2 text-sm text-violet-900">
          Synced from {sourceLabel} — billing and payments are managed in{' '}
          {sourceLabel}. The paid balance shown here is informational; see{' '}
          {sourceLabel} for the authoritative amount.
        </div>
      )}

      {(invoice.customerId || invoice.serviceRequestId || invoice.estimateId) && (
        <div className="flex flex-wrap gap-4 text-sm">
          {invoice.customerId && (
            <Link
              href={`/admin/customers/${invoice.customerId}`}
              className="text-primary hover:underline"
            >
              View customer
            </Link>
          )}
          {invoice.serviceRequestId && (
            <Link
              href={`/admin/requests?request=${invoice.serviceRequestId}`}
              className="text-primary hover:underline"
            >
              View request
            </Link>
          )}
          {invoice.estimateId && (
            <Link
              href={`/admin/estimates/${invoice.estimateId}`}
              className="text-primary hover:underline"
            >
              View estimate
            </Link>
          )}
        </div>
      )}

      {/* Line items + totals */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Line items</CardTitle>
        </CardHeader>
        <CardContent>
          {invoice.lineItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No line items.</p>
          ) : (
            <ul className="space-y-1.5">
              {invoice.lineItems.map((li) => (
                <li key={li.id} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {li.name}
                    {li.quantity > 1 ? ` × ${li.quantity}` : ''}
                  </span>
                  <span>{formatCentsExact(li.lineTotalCents)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 space-y-1 border-t pt-3 text-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>Subtotal</span>
              <span>{formatCentsExact(invoice.subtotalCents)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Tax</span>
              <span>{formatCentsExact(invoice.taxCents)}</span>
            </div>
            <div className="flex justify-between font-medium">
              <span>Total</span>
              <span>{formatCentsExact(invoice.totalCents)}</span>
            </div>
            <div className="flex justify-between text-muted-foreground">
              <span>Paid</span>
              <span>{formatCentsExact(invoice.amountPaidCents)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>Balance</span>
              <span className={balance > 0 ? 'text-amber-700' : undefined}>
                {formatCentsExact(balance)}
              </span>
            </div>
          </div>

          {/* Internal margin readout (admin-only; subordinate styling). When the
              tech recorded actual field materials on the linked job, show the
              ESTIMATED figure (line snapshots) and the ACTUAL figure side by
              side — the estimate is never overwritten. */}
          <div className="mt-3 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wide">
              Margin (internal){hasActual ? ' — estimated' : ''}
            </div>
            <div className="flex justify-between">
              <span>Revenue</span>
              <span className="tabular-nums">
                {formatCentsExact(margin.revenueCents)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>{hasActual ? 'Estimated cost' : 'Cost'}</span>
              <span className="tabular-nums">
                {formatCentsExact(margin.costCents)}
              </span>
            </div>
            <div className="flex justify-between font-medium text-foreground">
              <span>{hasActual ? 'Estimated margin' : 'Margin'}</span>
              <span className="tabular-nums">
                {formatCentsExact(margin.marginCents)} (
                {(margin.marginPct * 100).toFixed(1)}%)
              </span>
            </div>

            {hasActual && actualMargin && (
              <div className="mt-2 border-t pt-2">
                <div className="mb-1 text-[10px] font-medium uppercase tracking-wide">
                  Actual (field)
                </div>
                {actualMaterialsCostCents !== null && (
                  <div className="flex justify-between">
                    <span>Actual materials cost</span>
                    <span className="tabular-nums">
                      {formatCentsExact(actualMaterialsCostCents)}
                    </span>
                  </div>
                )}
                {actualLaborCostCents !== null && (
                  <div className="flex justify-between">
                    <span>Actual labor cost</span>
                    <span className="tabular-nums">
                      {formatCentsExact(actualLaborCostCents)}
                    </span>
                  </div>
                )}
                <div className="flex justify-between font-medium text-foreground">
                  <span>Actual margin</span>
                  <span className="tabular-nums">
                    {formatCentsExact(actualMargin.marginCents)} (
                    {(actualMargin.marginPct * 100).toFixed(1)}%)
                  </span>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Take payment — never for a read-only FSM-synced invoice (canTakePayment). */}
      {canTakePayment && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Take payment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  $
                </span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={payAmount}
                  onChange={(e) => setPayAmount(e.target.value)}
                  className="w-40 pl-6"
                />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input"
                  checked={isDeposit}
                  onChange={(e) => setIsDeposit(e.target.checked)}
                />
                Deposit
              </label>
              <Button
                size="sm"
                disabled={isPaying || !payAmount}
                onClick={handleTakePayment}
              >
                {isPaying ? 'Charging…' : 'Charge'}
              </Button>
            </div>
            {payError && <p className="text-xs text-destructive">{payError}</p>}
          </CardContent>
        </Card>
      )}

      {/* Financing (subordinate). Keyed to the invoice's estimate; only shown
          when the invoice links to one and a balance remains to finance. */}
      {invoice.estimateId && balance > 0 && (
        <FinancingPanel
          invoiceId={invoice.id}
          requestedAmountCents={balance}
        />
      )}

      {/* Payments + per-payment refunds */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Payments ({invoice.payments.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {invoice.payments.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            <div className="space-y-3">
              {invoice.payments.map((p) => {
                const refunded = p.refunds.reduce((s, r) => s + r.amountCents, 0);
                const refundable =
                  p.status === 'succeeded' && refunded < p.amountCents;
                return (
                  <div key={p.id} className="rounded-lg border p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-medium">
                          {formatCentsExact(p.amountCents)}
                        </span>
                        <span className="rounded-full border bg-muted px-2 py-0.5 text-xs">
                          {p.status}
                        </span>
                        {p.isDeposit && (
                          <span className="rounded-full border bg-blue-50 px-2 py-0.5 text-xs text-blue-700">
                            deposit
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(p.createdAt)}
                        </span>
                      </div>
                      {canRefund && !invoice.syncedSource && refundable && refundFor !== p.id && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setRefundFor(p.id);
                            setRefundAmount('');
                            setRefundReason('customer_request');
                            setRefundError(null);
                          }}
                        >
                          Refund
                        </Button>
                      )}
                    </div>

                    {/* Existing refunds */}
                    {p.refunds.length > 0 && (
                      <ul className="mt-2 space-y-1 border-t pt-2">
                        {p.refunds.map((r) => (
                          <li
                            key={r.id}
                            className="flex justify-between text-xs text-muted-foreground"
                          >
                            <span>
                              Refunded {r.reason ? `(${r.reason})` : ''}{' '}
                              {formatDateTime(r.createdAt)}
                            </span>
                            <span>-{formatCentsExact(r.amountCents)}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {/* Inline refund form (super_admin only; never for synced;
                        only while still refundable — matches the button gate so a
                        fully-refunded payment can't keep an open form). */}
                    {canRefund && !invoice.syncedSource && refundable && refundFor === p.id && (
                      <div className="mt-3 space-y-2 border-t pt-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="relative">
                            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                              $
                            </span>
                            <Input
                              type="number"
                              min="0"
                              step="0.01"
                              inputMode="decimal"
                              placeholder="0.00"
                              value={refundAmount}
                              onChange={(e) => setRefundAmount(e.target.value)}
                              className="w-32 pl-6"
                            />
                          </div>
                          <select
                            value={refundReason}
                            onChange={(e) => setRefundReason(e.target.value)}
                            className="flex h-9 rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {REFUND_REASONS.map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                              </option>
                            ))}
                          </select>
                          <Button
                            size="sm"
                            disabled={isRefunding || !refundAmount}
                            onClick={() => void handleRefund(p.id)}
                          >
                            {isRefunding ? 'Refunding…' : 'Confirm refund'}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setRefundFor(null)}
                          >
                            Cancel
                          </Button>
                        </div>
                        {refundError && (
                          <p className="text-xs text-destructive">{refundError}</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
