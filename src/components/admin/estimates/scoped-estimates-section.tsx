'use client';

import { useState } from 'react';
import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { useEstimates } from '@/hooks/use-estimates';
import { EstimateCreateDialog } from '@/components/admin/estimates/estimate-create-dialog';
import { EstimateStatusBadge } from '@/components/admin/estimates/estimate-status-badge';
import { Button } from '@/components/ui/button';
import { formatCentsExact } from '@/lib/admin/money-format';

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
 * with a "Create estimate" button that opens the create flow pre-filled. Reuses
 * useEstimates and filters client-side (estimate volume per entity is small).
 */
export function ScopedEstimatesSection({
  customerId,
  serviceRequestId,
  variant = 'card',
}: ScopedEstimatesSectionProps) {
  const { estimates, isLoading, refetch } = useEstimates();
  const [createOpen, setCreateOpen] = useState(false);

  const scoped = estimates.filter((e) =>
    serviceRequestId
      ? e.serviceRequestId === serviceRequestId
      : e.customerId === customerId,
  );

  const body = (
    <>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : scoped.length === 0 ? (
        <p className="text-sm text-muted-foreground">No estimates yet.</p>
      ) : (
        <div className="space-y-2">
          {scoped.map((est) => (
            <Link
              key={est.id}
              href={`/admin/estimates/${est.id}`}
              className="flex items-center justify-between rounded-lg border p-3 hover:bg-muted/30"
            >
              <div className="flex items-center gap-3">
                <EstimateStatusBadge status={est.status} />
                <span className="text-xs text-muted-foreground">
                  {formatDate(est.createdAt)}
                </span>
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
        onCreated={() => void refetch()}
      />
    </>
  );

  if (variant === 'plain') {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <FileText className="size-4" />
            Estimates ({scoped.length})
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
          Estimates ({scoped.length})
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
