'use client';

import Link from 'next/link';
import { AlertCircle, ArrowUpRight, Plug } from 'lucide-react';
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
    className: 'bg-success-light text-success border-success/30',
  },
  connected: {
    label: 'Connected',
    className: 'bg-success-light text-success border-success/30',
  },
  mock: {
    label: 'Mock',
    className: 'bg-warning-light text-warning-foreground border-warning/30',
  },
  not_configured: {
    label: 'Not configured',
    className: 'bg-muted text-muted-foreground border-border',
  },
};

export default function IntegrationsPage() {
  const { integrations, isLoading, error } = useIntegrations();

  return (
    <PageShell>
      <PageHeader
        title="Integrations"
        subtitle="Connection status for every external service. Manage actions open the relevant setup flow."
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <SkeletonTable rows={4} cols={3} />
      ) : integrations.length === 0 ? (
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
    <Card className="p-4 transition-shadow duration-200 hover:shadow-md hover:ring-1 hover:ring-primary/30">
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
            <ArrowUpRight className="size-4" />
          </Button>
        </div>
      )}
    </Card>
  );
}
