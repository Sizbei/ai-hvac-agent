'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Plus, AlertCircle, FileText } from 'lucide-react';
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
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {estimates.map((est) => (
                <tr key={est.id} className="border-t hover:bg-muted/30">
                  <td className="px-4 py-3">{formatDate(est.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5">
                        <EstimateStatusBadge status={est.status} />
                        {est.syncedSource === 'fieldpulse' && (
                          <span className="rounded border bg-violet-50 px-1.5 py-px text-[10px] font-medium text-violet-700">
                            FieldPulse
                          </span>
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
                  <td className="px-4 py-3 font-medium">
                    {formatCentsExact(est.totalCents)}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
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
                    <Link href={`/admin/estimates/${est.id}`}>
                      <Button variant="outline" size="sm">
                        View
                      </Button>
                    </Link>
                  </td>
                </tr>
              ))}
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
