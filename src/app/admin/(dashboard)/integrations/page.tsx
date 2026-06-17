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
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';

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

const STATUS_META: Record<
  IntegrationStatus,
  {
    readonly label: string;
    readonly variant: 'default' | 'secondary' | 'outline' | 'destructive';
  }
> = {
  live: { label: 'Live', variant: 'default' },
  connected: { label: 'Connected', variant: 'default' },
  mock: { label: 'Mock', variant: 'secondary' },
  not_configured: { label: 'Not configured', variant: 'outline' },
};

export default function IntegrationsPage() {
  const { integrations, isLoading, error } = useIntegrations();

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight">
          Integrations
        </h1>
        <p className="text-sm text-muted-foreground">
          Connection status for every external service. Manage actions open the
          relevant setup flow.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          {CATEGORY_SECTIONS.map((section) => {
            const items = integrations.filter(
              (i) => i.category === section.category,
            );
            if (items.length === 0) return null;
            return (
              <section key={section.category} className="space-y-3">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.heading}
                </h2>
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
    </div>
  );
}

function IntegrationCard({ item }: { readonly item: IntegrationStatusItem }) {
  const meta = STATUS_META[item.status];
  return (
    <Card className="p-4 transition-shadow duration-200 hover:shadow-md hover:ring-1 hover:ring-primary/30">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="shrink-0 rounded-xl bg-slate-100 p-2.5 dark:bg-slate-800/50">
            <Plug className="h-5 w-5 text-slate-600 dark:text-slate-300" />
          </div>
          <div className="min-w-0">
            <p className="font-medium">{item.label}</p>
            <p className="mt-0.5 text-sm text-muted-foreground">{item.detail}</p>
          </div>
        </div>
        <Badge variant={meta.variant} className="shrink-0">
          {meta.label}
        </Badge>
      </div>

      {item.configurable && item.manageHref && (
        <div className="mt-3 flex justify-end">
          <Button
            variant="outline"
            size="sm"
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
