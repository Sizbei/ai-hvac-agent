'use client';

import Link from 'next/link';
import { LoadErrorState } from '@/components/admin/ui/load-error-state';
import { listViewState } from '@/lib/admin/list-view-state';
import { AlertCircle, ChevronRight, Plug } from 'lucide-react';
import {
  useIntegrations,
  type IntegrationCategory,
  type IntegrationStatus,
  type IntegrationStatusItem,
} from '@/hooks/use-integrations';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { SectionHeading } from '@/components/admin/ui/section-heading';
import { IconChip } from '@/components/admin/ui/icon-chip';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { SkeletonTable } from '@/components/admin/ui/skeleton-table';
import { getIntegrationMeta } from '@/lib/admin/integration-meta';

/** Display order + heading for each category section. */
const CATEGORY_SECTIONS: ReadonlyArray<{
  readonly category: IntegrationCategory;
  readonly heading: string;
}> = [
  { category: 'FSM', heading: 'Field service & scheduling' },
  { category: 'payments', heading: 'Payments' },
  { category: 'financing', heading: 'Financing' },
  { category: 'comms', heading: 'Communications' },
  { category: 'ai', heading: 'AI' },
];

/** Token badge classes for integration status — no raw palette classes. */
const STATUS_BADGE: Record<IntegrationStatus, { label: string; className: string }> = {
  live: {
    label: 'Live',
    className: 'bg-success-light text-success-strong border-success-border',
  },
  connected: {
    label: 'Connected',
    className: 'bg-success-light text-success-strong border-success-border',
  },
  sync_failed: {
    label: 'Sync failed',
    className: 'bg-danger-light text-danger-strong border-danger-border',
  },
  mock: {
    label: 'Test mode',
    className: 'bg-warning-light text-warning-strong border-warning-border',
  },
  not_configured: {
    label: 'Not set up',
    className: 'bg-surface-raised text-muted-foreground border-border',
  },
};

export default function IntegrationsPage() {
  const { integrations, isLoading, error, refetch } = useIntegrations();
  const view = listViewState({ loading: isLoading, failed: error !== null, count: integrations.length });

  return (
    <PageShell>
      <PageHeader
        title="Integrations"
        subtitle="Connection status for every external service. Manage actions open the relevant setup flow."
      />

      {error && view === 'ready' && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>Couldn&apos;t refresh integrations. What you see may be out of date.</AlertDescription>
        </Alert>
      )}

      {view === 'loading' ? (
        <SkeletonTable rows={4} cols={3} />
      ) : view === 'error' ? (
        <LoadErrorState
          title="Couldn't load integrations."
          onRetry={refetch}
          className="rounded-lg border border-dashed"
        />
      ) : view === 'empty' ? (
        <EmptyState
          icon={Plug}
          title="No integrations found"
          description="Integration status could not be loaded. Try refreshing the page."
        />
      ) : (
        <div className="space-y-8">
          {CATEGORY_SECTIONS.map((section) => {
            const items = integrations.filter(
              (i) => i.category === section.category,
            );
            if (items.length === 0) return null;
            return (
              <section key={section.category} className="space-y-3">
                <SectionHeading title={section.heading} />
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  {items.map((item) => (
                    <IntegrationCard key={item.key} item={item} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </PageShell>
  );
}

function IntegrationCard({ item }: { readonly item: IntegrationStatusItem }) {
  const meta = getIntegrationMeta(item.key);
  const badge = STATUS_BADGE[item.status] ?? STATUS_BADGE.not_configured;

  return (
    <Card className="p-4 transition-colors duration-[var(--dur-hover)] hover:border-marker-border hover:bg-row-hover">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <IconChip icon={meta.icon} intent={meta.intent} />
          <div className="min-w-0">
            <p className="font-medium">{item.label}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{item.detail}</p>
          </div>
        </div>
        <Badge variant="outline" className={`shrink-0 ${badge.className}`}>
          {badge.label}
        </Badge>
      </div>

      {item.configurable && item.manageHref && (
        <div className="mt-3 flex justify-end">
          <Button
            variant="outline"
            size="sm"
            aria-label={`Manage ${item.label}`}
            render={<Link href={item.manageHref} />}
          >
            Manage
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </Card>
  );
}
