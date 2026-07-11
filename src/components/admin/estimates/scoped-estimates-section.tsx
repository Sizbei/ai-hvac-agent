'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { EstimateCreateDialog } from '@/components/admin/estimates/estimate-create-dialog';
import { EstimateStatusBadge } from '@/components/admin/estimates/estimate-status-badge';
import { Button } from '@/components/ui/button';
import { formatCentsExact } from '@/lib/admin/money-format';
import type { EstimateListItem } from '@/hooks/use-estimates';

interface ScopedEstimatesSectionProps {
  /** Exactly one of these scopes the list + pre-fills the create flow. */
  readonly customerId?: string;
  readonly serviceRequestId?: string;
  /** Render style: 'card' for full-card pages, 'plain' for the request sheet. */
  readonly variant?: 'card' | 'plain';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Thin read-only list of estimates scoped to a customer or service request,
 * with a "Create estimate" button that opens the create flow pre-filled.
 * Fetches server-filtered pages directly instead of pulling the full list
 * and filtering client-side.
 */
export function ScopedEstimatesSection({
  customerId,
  serviceRequestId,
  variant = 'card',
}: ScopedEstimatesSectionProps) {
  const [estimates, setEstimates] = useState<readonly EstimateListItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const scopeId = customerId ?? serviceRequestId;
    if (!scopeId) {
      setIsLoading(false);
      return;
    }

    let active = true;
    setIsLoading(true);
    setError(null);

    const qs = new URLSearchParams({ limit: '200' });
    if (customerId) qs.set('customerId', customerId);
    else if (serviceRequestId) qs.set('serviceRequestId', serviceRequestId);

    fetch(`/api/admin/estimates?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((body: { success: boolean; data: { estimates: EstimateListItem[] } }) => {
        if (active) setEstimates(body.data.estimates);
      })
      .catch(() => {
        if (active) setError('Could not load estimates.');
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [customerId, serviceRequestId, refreshKey]);

  const body = (
    <>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : estimates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No estimates yet.</p>
      ) : (
        <div className="space-y-2">
          {estimates.map((est) => (
            <Link
              key={est.id}
              href={`/admin/estimates/${est.id}`}
              className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/30"
            >
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-3">
                  <EstimateStatusBadge status={est.status} />
                  <span className="text-xs text-muted-foreground">
                    {formatDate(est.createdAt)}
                  </span>
                </div>
                {est.title && (
                  <span className="text-xs text-muted-foreground">{est.title}</span>
                )}
              </div>
              <span className="text-sm font-medium">
                {formatCentsExact(est.totalCents)}
              </span>
            </Link>
          ))}
        </div>
      )}

      <EstimateCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        customerId={customerId}
        serviceRequestId={serviceRequestId}
        onCreated={() => setRefreshKey((k) => k + 1)}
      />
    </>
  );

  if (variant === 'plain') {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="size-4" />
            Estimates ({estimates.length})
          </h3>
          <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 size-3" />
            Create
          </Button>
        </div>
        {body}
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card">
      <div className="flex items-center justify-between p-4 pb-2">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          <FileText className="size-4" />
          Estimates ({estimates.length})
        </h3>
        <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 size-3" />
          Create estimate
        </Button>
      </div>
      <div className="p-4 pt-2">{body}</div>
    </div>
  );
}
