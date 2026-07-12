'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Plus, AlertCircle, FileText } from 'lucide-react';
import { useEstimates } from '@/hooks/use-estimates';
import { EstimateCreateDialog } from '@/components/admin/estimates/estimate-create-dialog';
import { EstimateStatusBadge } from '@/components/admin/estimates/estimate-status-badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCentsExact } from '@/lib/admin/money-format';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { pageLabel } from '@/lib/admin/invoice-list-helpers';
import { SyncPill } from '@/components/admin/sync-pill';
import { FieldpulseDetails } from '@/components/admin/fieldpulse-details';

const PER_PAGE = 50;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function EstimatesPage() {
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { estimates, total, isLoading, error, refetch } = useEstimates({ page });

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  return (
    <PageShell>
      <PageHeader
        title="Estimates"
        subtitle="Good / better / best proposals with public e-sign approval."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New estimate
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : estimates.length === 0 ? (
        <div className="rounded-lg border border-dashed py-16 text-center">
          <FileText className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            No estimates yet. Create one to send a customer a proposal.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Created</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Total</th>
                <th className="px-4 py-2 font-medium">Links</th>
                <th className="px-4 py-2 w-8" />
              </tr>
            </thead>
            <tbody>
              {estimates.map((est) => {
                const isExpanded = expandedId === est.id;
                return (
                  // Key on the Fragment — it is the array element; keys on the
                  // inner <tr>s don't satisfy React's list reconciliation.
                  <Fragment key={est.id}>
                    <tr className="border-t hover:bg-muted/30 cursor-pointer">
                      <td
                        className="px-4 py-3"
                        onClick={() => setExpandedId((prev) => (prev === est.id ? null : est.id))}
                      >
                        {formatDate(est.createdAt)}
                      </td>
                      <td
                        className="px-4 py-3"
                        onClick={() => setExpandedId((prev) => (prev === est.id ? null : est.id))}
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5">
                            <EstimateStatusBadge status={est.status} />
                            {est.syncedSource === 'fieldpulse' && (
                              <SyncPill source={est.syncedSource} size="md" />
                            )}
                            {est.syncedSource === 'fieldpulse' && est.fieldpulseStatusName && (
                              <span className="text-[11px] text-muted-foreground">({est.fieldpulseStatusName})</span>
                            )}
                          </div>
                          {est.title && (
                            <span className="text-xs text-muted-foreground">{est.title}</span>
                          )}
                        </div>
                      </td>
                      <td
                        className="px-4 py-3 font-medium"
                        onClick={() => setExpandedId((prev) => (prev === est.id ? null : est.id))}
                      >
                        {formatCentsExact(est.totalCents)}
                      </td>
                      <td
                        className="px-4 py-3 text-xs text-muted-foreground"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {est.customerId && (
                          <Link
                            href={`/admin/customers/${est.customerId}`}
                            className="hover:underline"
                          >
                            Customer
                          </Link>
                        )}
                        {est.customerId && est.serviceRequestId && ' · '}
                        {est.serviceRequestId && (
                          <Link
                            href={`/admin/requests?request=${est.serviceRequestId}`}
                            className="hover:underline"
                          >
                            Request
                          </Link>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {/* Keyboard/AT toggle — the pricebook pattern: mouse
                            users toggle via the row cells, the chevron button
                            carries aria-expanded + focusability. */}
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                          onClick={() => setExpandedId((prev) => (prev === est.id ? null : est.id))}
                          className="ml-auto flex items-center justify-center rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {isExpanded
                            ? <ChevronDown className="size-4" />
                            : <ChevronRight className="size-4" />
                          }
                        </button>
                      </td>
                    </tr>
                    {isExpanded && (
                      /* No border-t: the panel reads as one unit with its row;
                         the NEXT row's border-t separates it from what follows. */
                      <tr key={`${est.id}-expand`}>
                        <td colSpan={5} className="bg-muted/30 px-6 py-4 animate-in fade-in-0 slide-in-from-top-1 duration-100">
                          <div className="flex flex-wrap gap-6">
                            {/* Key facts */}
                            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                              {est.title && (
                                <>
                                  <dt className="text-muted-foreground">Title</dt>
                                  <dd>{est.title}</dd>
                                </>
                              )}
                              <dt className="text-muted-foreground">Status</dt>
                              <dd>
                                <div className="flex items-center gap-1.5">
                                  <EstimateStatusBadge status={est.status} />
                                  {est.fieldpulseStatusName && (
                                    <span className="text-muted-foreground">({est.fieldpulseStatusName})</span>
                                  )}
                                </div>
                              </dd>
                              <dt className="text-muted-foreground">Total</dt>
                              <dd className="font-medium tabular-nums">{formatCentsExact(est.totalCents)}</dd>
                              <dt className="text-muted-foreground">Created</dt>
                              <dd className="tabular-nums">{formatDate(est.createdAt)}</dd>
                              {est.expiresAt && (
                                <>
                                  <dt className="text-muted-foreground">Expires</dt>
                                  <dd className="tabular-nums">{formatDate(est.expiresAt)}</dd>
                                </>
                              )}
                              {est.signedAt && (
                                <>
                                  <dt className="text-muted-foreground">Signed</dt>
                                  <dd className="tabular-nums">{formatDate(est.signedAt)}</dd>
                                </>
                              )}
                            </dl>

                            {/* FieldPulse details */}
                            {est.fieldpulseData && (
                              <div className="flex-1 min-w-48">
                                <FieldpulseDetails data={est.fieldpulseData} />
                              </div>
                            )}
                          </div>

                          {/* Primary action */}
                          <div className="mt-4" onClick={(e) => e.stopPropagation()}>
                            <Link href={`/admin/estimates/${est.id}`}>
                              <Button variant="outline" size="sm">
                                View estimate →
                              </Button>
                            </Link>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* pager bar — only shown when there are results */}
      {total > 0 && (
        <div className="flex items-center justify-between px-1 py-3 text-sm">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={safePage <= 1}
          >
            ← Prev
          </Button>
          <span className="tabular-nums text-xs text-muted-foreground">
            {pageLabel(safePage, total, PER_PAGE)}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPage(1)}
              disabled={safePage <= 1}
            >
              First
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPage(totalPages)}
              disabled={safePage >= totalPages}
            >
              Last
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
            >
              Next →
            </Button>
          </div>
        </div>
      )}

      <EstimateCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          // Jump back to page 1 so the newly-created estimate (newest-first) is
          // visible; the page change re-fetches, refetch() covers the already-
          // on-page-1 case.
          setPage(1);
          void refetch();
        }}
      />
    </PageShell>
  );
}
