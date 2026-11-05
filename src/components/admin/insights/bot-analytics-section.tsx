'use client';

import {
  Cpu,
  AlertTriangle,
  ClipboardCheck,
  Timer,
  Lightbulb,
  RefreshCw,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StatCard, StatStrip } from '@/components/admin/ui/stat-card';
import { ProgressBar } from '@/components/admin/ui/progress-bar';
import { SectionHeading } from '@/components/admin/ui/section-heading';
import { useBotAnalytics } from '@/hooks/use-bot-analytics';
import type {
  IntentDistributionRow,
  OutcomeDistributionRow,
} from '@/lib/admin/bot-analytics-queries';
import { formatRatio } from '@/lib/admin/report-format';

const OUTCOME_LABELS: Record<string, string> = {
  booked: 'Booked',
  escalated: 'Escalated',
  info_provided: 'Info provided',
  abandoned: 'Abandoned',
  unresolved: 'Unresolved',
  unclassified: 'Unclassified',
};


/** Humanize a router intent id ("emergency-gas-smell" -> "emergency gas smell"). */
function humanizeIntent(intentId: string): string {
  return intentId.replace(/^custom-faq:/, 'custom: ').replace(/[-_]/g, ' ');
}

function humanizeOutcome(outcome: string): string {
  return OUTCOME_LABELS[outcome] ?? outcome.replace(/_/g, ' ');
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
          <ProgressBar
            value={Math.round((r.count / max) * 100)}
            label={`${format(r.key)}: ${r.count}`}
            className="h-1.5 flex-1"
          />
          <span className="w-10 shrink-0 text-right font-mono text-sm tabular-nums">
            {r.count}
          </span>
        </div>
      ))}
    </div>
  );
}

export function BotAnalyticsSection() {
  const { data, isLoading, error, refetch } = useBotAnalytics();

  const intentRows = (data?.intentDistribution ?? []).map(
    (r: IntentDistributionRow) => ({ key: r.intentId, count: r.count }),
  );
  const outcomeRows = (data?.outcomeDistribution ?? []).map(
    (r: OutcomeDistributionRow) => ({ key: r.outcome, count: r.count }),
  );
  // Turn ratios divide by turns; the abandon rate by sessions with an outcome.
  // With nothing behind them they render "—", never "0%".
  const turns = data?.totalTurns ?? 0;
  const classified = outcomeRows
    .filter((r) => r.key !== 'unclassified')
    .reduce((sum, r) => sum + r.count, 0);
  const sessions = outcomeRows.reduce((sum, r) => sum + r.count, 0);

  return (
    <section aria-labelledby="bot-analytics-heading" className="space-y-4">
      <SectionHeading
        as="h2"
        title="Bot analytics"
        right={
          <span className="text-xs text-muted-foreground">
            {data
              ? `${data.totalTurns} turns · ${sessions} conversations · last 30 days`
              : 'Last 30 days'}
          </span>
        }
      />
      <p className="text-xs text-muted-foreground">
        Everything in this section covers the last 30 days. The AI assistant
        totals above are all-time, so the two can differ.
      </p>

      {error && (
        <Alert variant="destructive">
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void refetch()}
            >
              <RefreshCw className="mr-2 size-4" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <StatStrip>
        <StatCard
          icon={Cpu}
          label="Instant reply ratio"
          value={data ? formatRatio(data.deterministicRatio, turns) : '—'}
          intent="info"
          size="sm"
          loading={isLoading}
        />
        <StatCard
          icon={AlertTriangle}
          label="Escalation rate"
          value={data ? formatRatio(data.escalationRate, turns) : '—'}
          intent="warning"
          size="sm"
          loading={isLoading}
        />
        <StatCard
          icon={ClipboardCheck}
          label="Extraction completion"
          value={data ? formatRatio(data.extractionCompletionRate, turns) : '—'}
          intent="success"
          size="sm"
          loading={isLoading}
        />
        <StatCard
          icon={Timer}
          label="Avg latency"
          value={data?.avgLatencyMs != null ? `${data.avgLatencyMs} ms` : '—'}
          intent="neutral"
          size="sm"
          loading={isLoading}
        />
        <StatCard
          icon={Lightbulb}
          label="Knowledge answers"
          value={data ? formatRatio(data.knowledgeAnswerRate, turns) : '—'}
          intent="primary"
          size="sm"
          loading={isLoading}
        />
      </StatStrip>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="border-t-2 border-t-signal p-4">
          <p className="mb-3 text-sm font-medium">Top intents</p>
          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <BarList rows={intentRows} format={humanizeIntent} />
          )}
        </Card>

        <Card className="border-t-2 border-t-signal p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-medium">Conversation outcomes</p>
            {data && classified > 0 && (
              <span className="text-xs text-muted-foreground">
                {formatRatio(data.abandonRate, classified)} of classified abandoned
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
