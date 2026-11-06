'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Receipt, Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { selectLabel } from '@/lib/admin/select-label';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { InfoBanner } from '@/components/admin/ui/info-banner';
import { ErrorState } from '@/components/admin/ui/error-state';
import { LoadErrorState } from '@/components/admin/ui/load-error-state';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { detailLoadFailure, type DetailLoadFailure } from '@/lib/admin/detail-load';
import { canOfferFinancing } from '@/lib/admin/invoice-payment-copy';
import { EstimateStatusBadge } from '@/components/admin/estimates/estimate-status-badge';
import { FinancingPanel } from '@/components/admin/financing/financing-panel';
import { approvalLines } from '@/lib/admin/estimate-approval-copy';
import { businessDay, businessWhen, estimateInvoiceCard } from '@/lib/admin/estimate-detail-display';
import { formatCentsExact } from '@/lib/admin/money-format';
import { rollUpMargin, hasUncostedLines, UNCOSTED_MARGIN_NOTE } from '@/lib/admin/margin';
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
  readonly customerName: string | null;
  readonly markedSoldBy: string | null;
  readonly soldVia: string | null;
  readonly soldByName: string | null;
  readonly fieldpulseData: Record<string, unknown> | null;
  /** The invoice generated from this estimate, if any. */
  readonly invoiceId: string | null;
  /** With no office invoice: the job's invoice holding the sold lines (M3c field bill). */
  readonly jobInvoiceId: string | null;
}

/** "Furnace replacement", else "Estimate for Trevor Nunn", else "Estimate". */
function estimateHeading(title: string | null, customerName: string | null): string {
  if (title) return title;
  return customerName ? `Estimate for ${customerName}` : 'Estimate';
}

/** "Nov 5, 2026" — the same day format the invoice document uses. */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
  const [loadFailure, setLoadFailure] = useState<DetailLoadFailure | null>(null);
  const [confirmSoldOpen, setConfirmSoldOpen] = useState(false);
  const [selectedOption, setSelectedOption] = useState<string>('');
  const [isMarking, setIsMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [markedNotice, setMarkedNotice] = useState<string | null>(null);
  const [isInvoicing, setIsInvoicing] = useState(false);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [newApprovalUrl, setNewApprovalUrl] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/admin/estimates/${id}`);
      if (!res.ok) {
        setLoadFailure(detailLoadFailure(res.status));
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { estimate: EstimateDetail };
      };
      if (body.success) {
        setEstimate(body.data.estimate);
        setSelectedOption(body.data.estimate.options[0]?.id ?? '');
        setLoadFailure(null);
      }
    } catch {
      setLoadFailure(detailLoadFailure(null));
    } finally {
      setIsLoading(false);
    }
  }, [id]);

  const retryLoad = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    await load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleMarkSold = useCallback(async (): Promise<void> => {
    if (!selectedOption) return;
    setConfirmSoldOpen(false);
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
        const won = estimate?.options.find((o) => o.id === selectedOption);
        setMarkedNotice(
          won ? `Marked sold: ${won.name}. Generate the invoice when you're ready.` : 'Marked sold.',
        );
        void load();
      } else {
        setMarkError(body.error?.message ?? 'Failed to mark sold');
      }
    } catch {
      setMarkError('Could not connect to server.');
    } finally {
      setIsMarking(false);
    }
  }, [id, selectedOption, load, estimate]);

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
        // ?created=1 only for a NEW invoice: the invoice page then confirms
        // it. An existing one (created: false) opens without the banner.
        const createdParam = body.data.created === false ? '' : '?created=1';
        router.push(`/admin/invoices/${body.data.invoiceId}${createdParam}`);
      } else {
        setInvoiceError(body.error?.message ?? 'Failed to generate invoice');
        setIsInvoicing(false);
      }
    } catch {
      setInvoiceError('Could not connect to server.');
      setIsInvoicing(false);
    }
  }, [id, router]);

  const handleRegenerateLink = useCallback(async (): Promise<void> => {
    setIsRegenerating(true);
    setRegenerateError(null);
    try {
      const res = await fetch(`/api/admin/estimates/${id}/regenerate-link`, {
        method: 'POST',
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setNewApprovalUrl(body.data.approvalUrl);
        setLinkCopied(false);
      } else {
        setRegenerateError(body.error?.message ?? 'Failed to create a new link');
      }
    } catch {
      setRegenerateError('Could not connect to server.');
    } finally {
      setIsRegenerating(false);
    }
  }, [id]);

  const handleCopyLink = useCallback(async (): Promise<void> => {
    if (!newApprovalUrl) return;
    try {
      await navigator.clipboard.writeText(newApprovalUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } catch {
      // Clipboard may be blocked; the link is still visible to copy manually.
    }
  }, [newApprovalUrl]);

  if (isLoading) {
    return (
      <PageShell>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48 w-full" />
      </PageShell>
    );
  }

  // Only a page with nothing loaded is replaced; a failed reload after Mark
  // sold keeps the estimate on screen.
  if (!estimate) {
    return (
      <PageShell>
        <PageHeader title="Estimate" back={{ href: '/admin/estimates', label: 'Back to estimates' }} />
        {loadFailure === 'not_found' ? (
          <ErrorState
            title="Estimate not found"
            description="This estimate may have been removed, or the link is out of date."
            action={
              <Link href="/admin/estimates">
                <Button variant="outline">Back to estimates</Button>
              </Link>
            }
          />
        ) : (
          <LoadErrorState title="Couldn't load this estimate." onRetry={retryLoad} />
        )}
      </PageShell>
    );
  }

  const isOpen = estimate.status === 'open';
  const isSynced = estimate.syncedSource === 'fieldpulse';
  const invoiceCard = estimateInvoiceCard(estimate);

  return (
    <PageShell>
      <PageHeader
        title={estimateHeading(estimate.title, estimate.customerName)}
        back={{ href: '/admin/estimates', label: 'Back to estimates' }}
        subtitle={[
          estimate.title && estimate.customerName ? estimate.customerName : null,
          `Created ${businessDay(estimate.createdAt)}`,
          estimate.dueDate ? `Due ${formatDay(estimate.dueDate)}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <>
            <EstimateStatusBadge status={estimate.status} />
            {isSynced && estimate.fieldpulseStatusName && (
              <span className="ml-1 text-[11px] text-muted-foreground">({estimate.fieldpulseStatusName})</span>
            )}
            {isSynced && (
              <SyncPill source={estimate.syncedSource} size="md" />
            )}
          </>
        }
      />

      {/* ── Synced source banner ── */}
      {isSynced && (
        <InfoBanner>
          Synced from FieldPulse — estimates are managed there.
        </InfoBanner>
      )}

      {(estimate.customerId || estimate.serviceRequestId) && (
        <div className="flex gap-4 text-sm">
          {estimate.customerId && (
            <Link
              href={`/admin/customers/${estimate.customerId}`}
              className="text-link hover:underline"
            >
              View customer
            </Link>
          )}
          {estimate.serviceRequestId && (
            <Link
              href={`/admin/requests?request=${estimate.serviceRequestId}`}
              className="text-link hover:underline"
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
          <Card key={opt.id} className={isSold ? 'border-success' : undefined}>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
                <span>
                  {opt.name}
                  {isSold && (
                    <span className="ml-2 text-xs font-medium text-success">
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
                <div className="mb-1 font-medium text-foreground">
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
                {hasUncostedLines(opt.lineItems) && (
                  <p className="mt-1">{UNCOSTED_MARGIN_NOTE}</p>
                )}
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
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            {approvalLines(
              {
                soldVia: estimate.soldVia,
                signatureName: estimate.signatureName,
                soldByName: estimate.soldByName,
                markedSoldBy: estimate.markedSoldBy,
                signedAt: estimate.signedAt,
              },
              businessWhen,
              businessDay,
            ).map((line, i) => (
              <p key={i}>
                {line.map((seg, j) =>
                  seg.strong ? <span key={j} className="font-medium text-foreground">{seg.text}</span> : <span key={j}>{seg.text}</span>,
                )}
              </p>
            ))}
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
            {markedNotice && (
              <p role="status" className="text-sm text-foreground">
                {markedNotice}
              </p>
            )}
            {invoiceCard.kind !== 'generate' ? (
              <>
                {/* Already billed (office or the job's invoice): no Generate (final review B P2-1). */}
                <p className="text-sm text-muted-foreground">
                  {invoiceCard.kind === 'job' ? "On the job's invoice" : 'Invoice created'}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link href={`/admin/invoices/${invoiceCard.invoiceId}`} />}
                >
                  <Receipt className="mr-2 size-4" />
                  View invoice
                </Button>
              </>
            ) : (
              <>
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
              </>
            )}
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
          return canOfferFinancing({ customerId: estimate.customerId, amountCents }) ? (
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
              <Select value={selectedOption} onValueChange={(v) => setSelectedOption(v ?? '')}>
                <SelectTrigger aria-label="Estimate option to mark sold" className="w-auto min-w-[220px]">
                  <SelectValue>
                    {(v: unknown) =>
                      selectLabel(
                        estimate.options.map((o) => ({
                          value: o.id,
                          label: `${o.name} — ${formatCentsExact(o.totalCents)}`,
                        })),
                        v,
                        'Choose the option',
                      )
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {estimate.options.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.name} — {formatCentsExact(o.totalCents)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                disabled={isMarking || !selectedOption}
                onClick={() => setConfirmSoldOpen(true)}
              >
                {isMarking ? 'Saving…' : 'Mark sold'}
              </Button>
            </div>
            {markError && <p className="text-xs text-destructive">{markError}</p>}
          </CardContent>
        </Card>
      )}
      {isOpen && !isSynced && (() => {
        const chosen = estimate.options.find((o) => o.id === selectedOption);
        return (
          <ConfirmDialog
            open={confirmSoldOpen}
            onOpenChange={setConfirmSoldOpen}
            title={chosen ? `Mark ${chosen.name} sold?` : 'Mark this estimate sold?'}
            description={
              chosen
                ? `${chosen.name} — ${formatCentsExact(chosen.totalCents)} is recorded as the option the customer accepted. This can't be undone here.`
                : "This can't be undone here."
            }
            confirmLabel="Mark sold"
            cancelLabel="Not yet"
            onConfirm={() => void handleMarkSold()}
          />
        );
      })()}

      {/* Approval link — only while open and not synced. The plaintext token is
          never persisted, so this is the only way to recover a link once the
          create dialog's one-time display is dismissed. Regenerating invalidates
          any previous link (only the newest token's hash is ever stored). */}
      {isOpen && !isSynced && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Approval link</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {newApprovalUrl ? (
              <div className="flex items-center gap-2">
                <Input readOnly value={newApprovalUrl} className="font-mono text-xs" />
                <Button type="button" variant="outline" size="sm" onClick={handleCopyLink}>
                  {linkCopied ? <Check className="size-4" /> : <Copy className="size-4" />}
                </Button>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Get a new customer approval link. This replaces any link sent
                  before — the old one stops working.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isRegenerating}
                  onClick={handleRegenerateLink}
                >
                  {isRegenerating ? 'Creating…' : 'Get new link'}
                </Button>
              </>
            )}
            {regenerateError && <p className="text-xs text-destructive">{regenerateError}</p>}
          </CardContent>
        </Card>
      )}

      {/* FieldPulse spillover details — collapsed by default; hidden when null */}
      <FieldpulseDetails data={estimate.fieldpulseData} />
    </PageShell>
  );
}
