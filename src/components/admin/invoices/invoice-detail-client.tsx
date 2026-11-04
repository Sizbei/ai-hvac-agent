'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Link2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { SectionCard } from '@/components/admin/ui/section-card';
import { InfoBanner } from '@/components/admin/ui/info-banner';
import { ErrorState } from '@/components/admin/ui/error-state';
import { InvoiceStateBadge } from '@/components/admin/invoices/invoice-state-badge';
import { AgeChip } from '@/components/admin/invoices/age-chip';
import {
  InvoiceDocument,
  type DocumentInvoice,
  type OrgIdentity,
} from '@/components/admin/invoices/invoice-document';
import type { DocumentSignature, SignatureState } from '@/components/admin/invoices/invoice-signature-model';
import { RecordPaymentCard } from '@/components/admin/invoices/record-payment-card';
import { FinalizeButton } from '@/components/admin/invoices/finalize-button';
import { InvoiceCollectionsSide } from '@/components/admin/invoices/invoice-collections-side';
import { FinancingPanel } from '@/components/admin/financing/financing-panel';
import { formatCentsExact, parseDollarsToCents } from '@/lib/admin/money-format';
import { rollUpMargin, computeMargin, fpDiscountCents } from '@/lib/admin/margin';
import { deriveInvoicePresentation } from '@/lib/admin/invoice-presentation';
import { isCollectible, invoiceRef } from '@/lib/admin/invoice-collectible';
import { FieldpulseDetails } from '@/components/admin/fieldpulse-details';
import { SyncPill } from '@/components/admin/sync-pill';
import { mintKey } from '@/lib/http/idempotency-codes';
import {
  canRecordPayment,
  paymentMethodSummary,
  refundErrorCopy,
  refundSuccessCopy,
  shouldRemintToken,
} from '@/lib/admin/invoice-payment-copy';
import type { InvoiceDetailView, InvoiceReminderView } from '@/lib/admin/invoice-queries';

// Raw API response shape — dates arrive as ISO strings in JSON.
interface ApiRefund {
  readonly id: string;
  readonly amountCents: number;
  readonly reason: string | null;
  readonly createdAt: string;
}
interface ApiPayment {
  readonly id: string;
  readonly amountCents: number;
  readonly status: string;
  readonly isDeposit: boolean;
  readonly createdAt: string;
  readonly method: string;
  readonly checkNumber: string | null;
  readonly provider: string;
  readonly refunds: ApiRefund[];
}
interface ApiSignature {
  readonly state: SignatureState;
  readonly url: string | null;
  readonly name: string | null;
  readonly signedAt: string | null;
}
interface ApiInvoice {
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
  readonly issuedAt: string | null;
  readonly dueDate: string | null;
  readonly syncedSource: 'fieldpulse' | 'housecall' | null;
  readonly fieldpulseData: Record<string, unknown> | null;
  readonly lineItems: InvoiceDetailView['lineItems'];
  readonly payments: ApiPayment[];
  readonly actualMaterialsCostCents: number | null;
  readonly actualLaborCostCents: number | null;
  readonly customerName: string | null;
  readonly customerAddress: string | null;
  readonly customerPhone: string | null;
  readonly technicianName: string | null;
  readonly serviceDate: string | null;
  readonly lastReminderSentAt: string | null;
  readonly signature: ApiSignature;
  readonly requestSignature: ApiSignature | null;
}

function hydrateSignature(s: ApiSignature): DocumentSignature {
  return { ...s, signedAt: s.signedAt ? new Date(s.signedAt) : null };
}

const REFUND_REASONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'duplicate', label: 'Duplicate charge' },
  { value: 'customer_request', label: 'Customer request' },
  { value: 'defective', label: 'Defective / service issue' },
  { value: 'other', label: 'Other' },
];

function formatDateTime(d: Date): string {
  return d.toLocaleString();
}

/** Convert the API JSON response (string dates) into the client view (Date objects). */
function hydrateInvoice(raw: ApiInvoice): DocumentInvoice {
  return {
    ...raw,
    createdAt: new Date(raw.createdAt),
    issuedAt: raw.issuedAt ? new Date(raw.issuedAt) : null,
    dueDate: raw.dueDate ? new Date(raw.dueDate) : null,
    serviceDate: raw.serviceDate ? new Date(raw.serviceDate) : null,
    lastReminderSentAt: raw.lastReminderSentAt ? new Date(raw.lastReminderSentAt) : null,
    signature: hydrateSignature(raw.signature),
    requestSignature: raw.requestSignature ? hydrateSignature(raw.requestSignature) : null,
    payments: raw.payments.map((p) => ({
      ...p,
      createdAt: new Date(p.createdAt),
      refunds: p.refunds.map((r) => ({
        ...r,
        createdAt: new Date(r.createdAt),
      })),
    })),
  };
}

export function InvoiceDetailClient({
  id,
  canRefund,
}: {
  readonly id: string;
  readonly canRefund: boolean;
}) {
  const [invoice, setInvoice] = useState<DocumentInvoice | null>(null);
  const [org, setOrg] = useState<OrgIdentity | null>(null);
  const [reminders, setReminders] = useState<InvoiceReminderView[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Record-payment form (the card mints its own client token when it opens)
  const [showPaymentForm, setShowPaymentForm] = useState(false);

  // Refund: which payment is being refunded + form state
  const [refundFor, setRefundFor] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState('');
  const [refundReason, setRefundReason] = useState('customer_request');
  const [isRefunding, setIsRefunding] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [refundToken, setRefundToken] = useState('');
  const [refundNotice, setRefundNotice] = useState<string | null>(null);

  // Signed signature URLs expire; refetch on an image error, a bounded number
  // of times so a permanently broken object can't loop.
  const signatureRetries = useRef(0);

  // Send reminder
  const [isSendingReminder, setIsSendingReminder] = useState(false);
  const [reminderSentMsg, setReminderSentMsg] = useState<string | null>(null);

  // Copy pay link
  const [isCopyingLink, setIsCopyingLink] = useState(false);
  const [copyLinkMsg, setCopyLinkMsg] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/admin/invoices/${id}`);
      if (!res.ok) {
        setError(res.status === 404 ? 'Invoice not found' : 'Failed to load');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { invoice: ApiInvoice; org: OrgIdentity; reminders?: { at: string; channel: string; status: string }[] };
      };
      if (body.success) {
        setInvoice(hydrateInvoice(body.data.invoice));
        setOrg(body.data.org);
        setReminders(
          (body.data.reminders ?? []).map((r) => ({
            at: new Date(r.at),
            channel: r.channel,
            status: r.status,
          })),
        );
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

  // ── MONEY HANDLERS (refund; recording lives in RecordPaymentCard) ─────────

  const handleRefund = useCallback(
    async (paymentId: string, provider: string): Promise<void> => {
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
          body: JSON.stringify({ clientToken: refundToken, amountCents, reason: refundReason }),
        });
        const body = await res.json().catch(() => ({ success: false }));
        const ok = res.ok && body.success;
        if (shouldRemintToken(ok, body.error?.code)) setRefundToken(mintKey());
        if (ok) {
          setRefundFor(null);
          setRefundAmount('');
          setRefundReason('customer_request');
          setRefundNotice(refundSuccessCopy(provider));
          void load();
        } else {
          setRefundError(refundErrorCopy(body.error?.code));
        }
      } catch {
        setRefundError('Could not connect to server.');
      } finally {
        setIsRefunding(false);
      }
    },
    [refundAmount, refundReason, refundToken, load],
  );

  const handleSignatureError = useCallback((): void => {
    if (signatureRetries.current >= 2) return;
    signatureRetries.current += 1;
    void load();
  }, [load]);

  const handleSignatureLoad = useCallback((): void => {
    signatureRetries.current = 0;
  }, []);

  const handleRecorded = useCallback((): void => {
    setShowPaymentForm(false);
    void load();
  }, [load]);

  const handleFinalized = useCallback((): void => {
    void load();
  }, [load]);

  // ── COLLECTIONS HANDLERS ─────────────────────────────────────────────────

  const handleSendReminder = useCallback(async (): Promise<void> => {
    setIsSendingReminder(true);
    setReminderSentMsg(null);
    try {
      const res = await fetch(`/api/admin/invoices/${id}/send-reminder`, { method: 'POST' });
      if (res.ok) {
        setReminderSentMsg('Sent!');
        setTimeout(() => setReminderSentMsg(null), 3000);
        void load();
      } else {
        const body = (await res.json().catch(() => ({ error: {} }))) as {
          error?: { message?: string };
        };
        setReminderSentMsg(body.error?.message ?? 'Failed');
        setTimeout(() => setReminderSentMsg(null), 3000);
      }
    } catch {
      setReminderSentMsg('Error');
      setTimeout(() => setReminderSentMsg(null), 3000);
    } finally {
      setIsSendingReminder(false);
    }
  }, [id, load]);

  const handleCopyPayLink = useCallback(async (): Promise<void> => {
    setIsCopyingLink(true);
    setCopyLinkMsg(null);
    try {
      const res = await fetch(`/api/admin/invoices/${id}/pay-link`, { method: 'POST' });
      const body = (await res.json().catch(() => ({ success: false }))) as {
        success: boolean;
        data?: { payLink?: string };
        error?: { message?: string };
      };
      if (res.ok && body.success && body.data?.payLink) {
        await navigator.clipboard.writeText(body.data.payLink);
        setCopyLinkMsg('Copied!');
        setTimeout(() => setCopyLinkMsg(null), 3000);
      } else {
        setCopyLinkMsg(body.error?.message ?? 'Failed');
        setTimeout(() => setCopyLinkMsg(null), 3000);
      }
    } catch {
      setCopyLinkMsg('Error');
      setTimeout(() => setCopyLinkMsg(null), 3000);
    } finally {
      setIsCopyingLink(false);
    }
  }, [id]);

  if (isLoading) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_280px]">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </PageShell>
    );
  }

  if (error || !invoice) {
    return (
      <PageShell>
        <PageHeader title="Invoice" back={{ href: '/admin/invoices', label: 'Back to invoices' }} />
        <ErrorState
          title={error ?? 'Invoice not found'}
          description="This invoice may have been removed, or the link is out of date."
          action={
            <Link href="/admin/invoices">
              <Button variant="outline">Back to invoices</Button>
            </Link>
          }
        />
      </PageShell>
    );
  }

  // Derived display/affordance state (pure, unit-tested in invoice-presentation).
  // Read-only mirror from an FSM (FieldPulse / Housecall Pro): money is managed
  // there, so native pay/refund controls are hidden and a caveat is shown.
  const { balanceCents: balance, canTakePayment, sourceLabel } =
    deriveInvoicePresentation(invoice);
  // Drafts are never payable by hand — Finalize is their only money action.
  const showRecordPayment = canRecordPayment({ state: invoice.state, canTakePayment });
  // Margin is line revenue vs snapshotted line cost (excludes tax — tax is not
  // revenue). FieldPulse mirrors carry a header-level discount in spillover
  // that lines don't reflect — without it a fully-discounted invoice reads as
  // full revenue at 100% margin. Internal/admin-only readout.
  const margin = rollUpMargin(
    invoice.lineItems,
    fpDiscountCents(invoice.fieldpulseData),
  );
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

  const fallbackOrg: OrgIdentity = { companyName: '—', address: null, phone: null };

  return (
    <PageShell>
      {/* ── Header ── */}
      <PageHeader
        title={`Invoice ${invoiceRef(invoice.id)}`}
        back={{ href: '/admin/invoices', label: 'Back to invoices' }}
        actions={
          <>
            <InvoiceStateBadge state={invoice.state} />
            <AgeChip issuedAt={invoice.issuedAt?.toISOString() ?? null} createdAt={invoice.createdAt.toISOString()} state={invoice.state} />
            {invoice.syncedSource && (
              <SyncPill source={invoice.syncedSource} size="md" />
            )}
            {/* Send reminder — only for open collectible invoices, never synced */}
            {isCollectible(invoice) && !invoice.syncedSource && (
              <Button
                variant="outline"
                size="sm"
                className="min-w-[132px]"
                disabled={isSendingReminder}
                onClick={() => void handleSendReminder()}
              >
                <Send className="mr-1.5 size-3.5" />
                {reminderSentMsg ?? (isSendingReminder ? 'Sending…' : 'Send reminder')}
              </Button>
            )}
            {/* Copy pay link — hidden for synced invoices. Both this and the
                reminder button swap their label to a transient status
                ("Sent!", "Copied!", "Generating…"); the min-width keeps the
                whole right-aligned header row from reflowing when they do. */}
            {!invoice.syncedSource && (
              <Button
                variant="outline"
                size="sm"
                className="min-w-[132px]"
                disabled={isCopyingLink}
                onClick={() => void handleCopyPayLink()}
              >
                <Link2 className="mr-1.5 size-3.5" />
                {copyLinkMsg ?? (isCopyingLink ? 'Generating…' : 'Copy pay link')}
              </Button>
            )}
            {/* Finalize — native drafts only (a synced draft lives in its FSM) */}
            {invoice.state === 'draft' && !invoice.syncedSource && (
              <FinalizeButton invoiceId={invoice.id} onFinalized={handleFinalized} />
            )}
            {/* Record payment — native open invoices only (canRecordPayment) */}
            {showRecordPayment && (
              <Button size="sm" onClick={() => setShowPaymentForm((v) => !v)}>
                {showPaymentForm ? 'Hide form' : 'Record payment'}
              </Button>
            )}
          </>
        }
      />

      {/* ── Synced source banner ── */}
      {sourceLabel && (
        <InfoBanner>
          Synced from {sourceLabel} — billing and payments are managed in{' '}
          {sourceLabel}. The paid balance shown here is informational; see{' '}
          {sourceLabel} for the authoritative amount.
        </InfoBanner>
      )}

      {/* ── Related links ── */}
      {(invoice.customerId || invoice.serviceRequestId || invoice.estimateId) && (
        <div className="flex flex-wrap gap-4 text-sm">
          {invoice.customerId && (
            <Link
              href={`/admin/customers/${invoice.customerId}`}
              className="text-link hover:underline"
            >
              View customer
            </Link>
          )}
          {invoice.serviceRequestId && (
            <Link
              href={`/admin/requests?request=${invoice.serviceRequestId}`}
              className="text-link hover:underline"
            >
              View request
            </Link>
          )}
          {invoice.estimateId && (
            <Link
              href={`/admin/estimates/${invoice.estimateId}`}
              className="text-link hover:underline"
            >
              View estimate
            </Link>
          )}
        </div>
      )}

      {/* ── Main layout: document column (left) + collections sidebar (right) ── */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] gap-6 items-start">
        {/* Left column */}
        <div className="min-w-0 space-y-6">
          {/* Invoice document (paper layout — line items, parties, totals) */}
          <InvoiceDocument
            invoice={invoice}
            org={org ?? fallbackOrg}
            onSignatureError={handleSignatureError}
            onSignatureLoad={handleSignatureLoad}
          />

          {/* Internal margin readout (admin-only; subordinate styling). When the
              tech recorded actual field materials on the linked job, show the
              ESTIMATED figure (line snapshots) and the ACTUAL figure side by
              side — the estimate is never overwritten. */}
          <SectionCard
            title={hasActual ? 'Margin (internal) — estimated' : 'Margin (internal)'}
            contentClassName="text-xs text-muted-foreground"
          >
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
                <div className="mb-1 font-medium text-foreground">
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
          </SectionCard>

          {/* Record payment — never for a read-only FSM-synced invoice (canTakePayment).
              Toggled by the toolbar button above; mounting mints the client token. */}
          {showRecordPayment && showPaymentForm && (
            <RecordPaymentCard invoiceId={invoice.id} onRecorded={handleRecorded} />
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
              {refundNotice && (
                <p role="status" className="mb-3 text-sm text-foreground">
                  {refundNotice}
                </p>
              )}
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
                            <span className="inline-flex h-5 items-center rounded-[3px] border border-border bg-surface-raised px-1.5 text-[11px] font-medium">
                              {p.status}
                            </span>
                            <span className="inline-flex h-5 items-center rounded-[3px] border border-border bg-surface-sunken px-1.5 text-[11px] font-medium tabular-nums">
                              {paymentMethodSummary(p.method, p.checkNumber)}
                            </span>
                            {p.isDeposit && (
                              <span className="inline-flex h-5 items-center rounded-[3px] border border-info-border bg-info-light px-1.5 text-[11px] font-medium text-info-strong">
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
                                setRefundToken(mintKey());
                                setRefundAmount('');
                                setRefundReason('customer_request');
                                setRefundError(null);
                                setRefundNotice(null);
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
                                  aria-label="Refund amount in dollars"
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
                                aria-label="Refund reason"
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
                                onClick={() => void handleRefund(p.id, p.provider)}
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
                              <p role="alert" className="text-xs text-destructive">{refundError}</p>
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

          {/* FieldPulse spillover details — collapsed by default; hidden when null */}
          <FieldpulseDetails data={invoice.fieldpulseData} />
        </div>

        {/* Right column: collections + activity sidebar */}
        <InvoiceCollectionsSide invoice={invoice} reminders={reminders} />
      </div>
    </PageShell>
  );
}
