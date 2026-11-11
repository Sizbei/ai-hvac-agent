'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { SectionCard } from '@/components/admin/ui/section-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EstimateCreateDialog } from '@/components/admin/estimates/estimate-create-dialog';
import { EstimateStatusBadge } from '@/components/admin/estimates/estimate-status-badge';
import { SyncPill } from '@/components/admin/sync-pill';
import { formatCentsExact } from '@/lib/admin/money-format';
import { PROFILE_LIST_PREVIEW, previewRows, sharedSyncSource } from '@/lib/admin/customer-money-summary';
import type { EstimateListItem } from '@/hooks/use-estimates';

const FETCH_LIMIT = 500;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * The profile's Estimates card, on the same panel and row style as the other
 * profile cards. Dates are the estimate's own (`effectiveCreatedAt`: the
 * FieldPulse date for imports, not the import day). Create estimate opens the
 * create flow pre-filled with this customer.
 */
export function CustomerEstimatesCard({ customerId }: { readonly customerId: string }) {
  const [estimates, setEstimates] = useState<readonly EstimateListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    // Mounted with key={customerId}; a refresh after Create keeps the rows on
    // screen until the new list lands.
    let active = true;
    const qs = new URLSearchParams({ limit: String(FETCH_LIMIT), customerId });
    fetch(`/api/admin/estimates?${qs.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('load failed'))))
      .then((body: { data: { estimates: EstimateListItem[] } }) => {
        if (active) setEstimates(body.data.estimates);
      })
      .catch(() => {
        if (active) setError("Couldn't load estimates. Please try again.");
      });
    return () => {
      active = false;
    };
  }, [customerId, refreshKey]);

  const shared = estimates ? sharedSyncSource(estimates) : null;
  const rows = estimates ? previewRows(estimates, expanded) : [];

  return (
    <SectionCard
      title="Estimates"
      icon={FileText}
      count={estimates ? estimates.length : undefined}
      description={shared ? 'Synced from FieldPulse, read-only here' : undefined}
      action={
        <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus className="mr-1 size-3" />
          Create estimate
        </Button>
      }
    >
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !estimates ? (
        <div className="flex flex-col gap-1.5">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-[3px]" />
          ))}
        </div>
      ) : estimates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No estimates yet.</p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {rows.map((est) => (
            <Link
              key={est.id}
              href={`/admin/estimates/${est.id}`}
              className="flex items-center gap-3 rounded-[3px] bg-surface-sunken px-3 py-2 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="min-w-[4.5rem] shrink-0">
                <EstimateStatusBadge status={est.status} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">
                  {est.title?.trim() || 'Estimate'}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {formatDate(est.effectiveCreatedAt ?? est.createdAt)}
                </span>
              </span>
              {shared === null && <SyncPill source={est.syncedSource} size="sm" />}
              <span className="shrink-0 font-mono text-[13px] font-medium tabular-nums">
                {formatCentsExact(est.totalCents)}
              </span>
            </Link>
          ))}
          {estimates.length > rows.length && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setExpanded(true)}>
              Show all {estimates.length.toLocaleString('en-US')} estimates
            </Button>
          )}
          {expanded && estimates.length > PROFILE_LIST_PREVIEW && (
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setExpanded(false)}>
              Show fewer
            </Button>
          )}
        </div>
      )}

      <EstimateCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        customerId={customerId}
        onCreated={() => {
          setError(null);
          setRefreshKey((k) => k + 1);
        }}
      />
    </SectionCard>
  );
}
