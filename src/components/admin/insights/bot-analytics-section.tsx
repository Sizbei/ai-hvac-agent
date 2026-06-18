'use client';

import {
  Cpu,
  AlertTriangle,
  ClipboardCheck,
  Timer,
  Lightbulb,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useBotAnalytics } from '@/hooks/use-bot-analytics';
import type {
  IntentDistributionRow,
  OutcomeDistributionRow,
} from '@/lib/admin/bot-analytics-queries';

const OUTCOME_LABELS: Record<string, string> = {
  booked: 'Booked',
  escalated: 'Escalated',
  info_provided: 'Info provided',
  abandoned: 'Abandoned',
  unresolved: 'Unresolved',
  unclassified: 'Unclassified',
};

/** A ratio (0-1) as a whole-number percentage string. */
function pct(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

/** Humanize a router intent id ("emergency-gas-smell" -> "emergency gas smell"). */
function humanizeIntent(intentId: string): string {
  return intentId.replace(/^custom-faq:/, 'custom: ').replace(/[-_]/g, ' ');
}

function humanizeOutcome(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome.replace(/_/g, ' ');
}

function KpiCard({
  icon: Icon,
  label,
  value,
  bg,
  fg,
  isLoading,
}: {
  readonly icon: typeof Cpu;
  readonly label: string;
  readonly value: string;
  readonly bg: string;
  readonly fg: string;
  readonly isLoading: boolean;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-3">
        <div className={`rounded-lg p-2 ${bg}`}>
          <Icon className={`h-5 w-5 ${fg}`} />
        </div>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          {isLoading ? (
            <Skeleton className="mt-1 h-7 w-16" />
          ) : (
            <p className="text-2xl font-bold">{value}</p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** A labelled horizontal bar list — shares of a total. */
function BarList({
  rows,
  format,
}: {
  readonly rows: readonly { readonly key: string; readonly count: number }[];
  readonly format: (key: string) => string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No data yet.</p>;
  }
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-3">
          <span className="w-36 shrink-0 truncate text-sm" title={format(r.key)}>
            {format(r.key)}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.round((r.count / max) * 100)}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right text-sm font-medium">
            {r.count}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BotAnalyticsSection() {
  const { data, isLoading, error } = useBotAnalytics();

  const intentRows = (data?.intentDistribution ?? []).map(
    (r: IntentDistributionRow) => ({ key: r.intentId, count: r.count }),
  );
  const outcomeRows = (data?.outcomeDistribution ?? []).map(
    (r: OutcomeDistributionRow) => ({ key: r.outcome, count: r.count }),
  );

  return (
    <section className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">Bot analytics</h2>
        <span className="text-xs text-muted-foreground">
          {data ? `${data.totalTurns} turns · last 30 days` : 'last 30 days'}
        </span>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <KpiCard
          icon={Cpu}
          label="Deterministic ratio"
          value={data ? pct(data.deterministicRatio) : '0%'}
          bg="bg-purple-100 dark:bg-purple-900/30"
          fg="text-purple-600 dark:text-purple-400"
          isLoading={isLoading}
        />
        <KpiCard
          icon={AlertTriangle}
          label="Escalation rate"
          value={data ? pct(data.escalationRate) : '0%'}
          bg="bg-yellow-100 dark:bg-yellow-900/30"
          fg="text-yellow-600 dark:text-yellow-400"
          isLoading={isLoading}
        />
        <KpiCard
          icon={ClipboardCheck}
          label="Extraction completion"
          value={data ? pct(data.extractionCompletionRate) : '0%'}
          bg="bg-green-100 dark:bg-green-900/30"
          fg="text-green-600 dark:text-green-400"
          isLoading={isLoading}
        />
        <KpiCard
          icon={Timer}
          label="Avg latency"
          value={data?.avgLatencyMs != null ? `${data.avgLatencyMs} ms` : '—'}
          bg="bg-blue-100 dark:bg-blue-900/30"
          fg="text-blue-600 dark:text-blue-400"
          isLoading={isLoading}
        />
        <KpiCard
          icon={Lightbulb}
          label="Knowledge answers"
          value={data ? pct(data.knowledgeAnswerRate) : '0%'}
          bg="bg-teal-100 dark:bg-teal-900/30"
          fg="text-teal-600 dark:text-teal-400"
          isLoading={isLoading}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <p className="mb-3 text-sm font-medium">Top intents</p>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <BarList rows={intentRows} format={humanizeIntent} />
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium">Conversation outcomes</p>
            {data && (
              <span className="text-xs text-muted-foreground">
                {pct(data.abandonRate)} abandoned
              </span>
            )}
          </div>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <BarList rows={outcomeRows} format={humanizeOutcome} />
          )}
        </Card>
      </div>
    </section>
  );
}
