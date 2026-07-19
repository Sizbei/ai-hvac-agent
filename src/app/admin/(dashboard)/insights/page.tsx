'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  RefreshCw,
  Zap,
  MessagesSquare,
  ClipboardList,
  AlertTriangle,
  Ban,
  Cpu,
  Coins,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react';
import type { AiInsights } from '@/lib/admin/ai-insights-types';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { OpsInsightsSection } from '@/components/admin/insights/ops-insights-section';
import { BotAnalyticsSection } from '@/components/admin/insights/bot-analytics-section';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';

interface InsightCard {
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly bgColor: string;
  readonly iconColor: string;
  readonly value: (data: AiInsights) => string;
  readonly hint?: (data: AiInsights) => string;
}

const INSIGHT_CARDS: readonly InsightCard[] = [
  {
    label: 'Total conversations',
    icon: MessagesSquare,
    bgColor: 'bg-blue-100 dark:bg-blue-900/30',
    iconColor: 'text-blue-600 dark:text-blue-400',
    value: (d) => String(d.totalSessions),
  },
  {
    label: 'Requests created',
    icon: ClipboardList,
    bgColor: 'bg-green-100 dark:bg-green-900/30',
    iconColor: 'text-green-600 dark:text-green-400',
    value: (d) => String(d.submittedRequests),
    hint: (d) => `${d.conversionRate}% conversion`,
  },
  {
    label: 'Escalated',
    icon: AlertTriangle,
    bgColor: 'bg-yellow-100 dark:bg-yellow-900/30',
    iconColor: 'text-yellow-600 dark:text-yellow-400',
    value: (d) => String(d.escalatedSessions),
  },
  {
    label: 'Abandoned',
    icon: Ban,
    bgColor: 'bg-red-100 dark:bg-red-900/30',
    iconColor: 'text-red-600 dark:text-red-400',
    value: (d) => String(d.abandonedSessions),
  },
  {
    label: 'Deterministic vs LLM replies',
    icon: Cpu,
    bgColor: 'bg-purple-100 dark:bg-purple-900/30',
    iconColor: 'text-purple-600 dark:text-purple-400',
    value: (d) => `${d.deterministicReplies} / ${d.llmReplies}`,
    hint: () => 'no-LLM / LLM assistant turns',
  },
  {
    label: 'Total AI tokens used',
    icon: Coins,
    bgColor: 'bg-orange-100 dark:bg-orange-900/30',
    iconColor: 'text-orange-600 dark:text-orange-400',
    value: (d) => d.totalTokensUsed.toLocaleString(),
  },
] as const;

export default function AiInsightsPage() {
  useEffect(() => { document.title = 'Insights · Spears Admin'; }, []);
  const [data, setData] = useState<AiInsights | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchInsights = useCallback(async (): Promise<void> => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;

    try {
      const res = await fetch('/api/admin/ai-insights');

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'Failed to fetch AI insights' },
        }));
        setError(body?.error?.message ?? 'Failed to fetch AI insights');
        return;
      }

      const body = (await res.json()) as {
        success: boolean;
        data: AiInsights;
      };

      if (body.success) {
        setData(body.data);
        setError(null);
      }
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    fetchInsights().finally(() => setIsLoading(false));
  }, [fetchInsights]);

  const handleRefresh = useCallback(() => {
    setIsLoading(true);
    void fetchInsights().finally(() => setIsLoading(false));
  }, [fetchInsights]);

  return (
    <PageShell>
      <PageHeader
        title="AI insights"
        subtitle="Deflection rate, session outcomes, and token usage for the AI assistant."
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isLoading}
          >
            <RefreshCw className={`size-4 ${isLoading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Headline: deflection rate */}
      <Card className="p-6">
        <div className="flex items-start gap-4">
          <div className="p-3 rounded-lg bg-primary/10">
            <Zap className="h-6 w-6 text-primary" />
          </div>
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">Deflection rate</p>
            {isLoading || !data ? (
              <Skeleton className="h-12 w-28 mt-1" />
            ) : (
              <p className="text-5xl font-bold tracking-tight">
                {data.deflectionRate}%
              </p>
            )}
            <p className="mt-2 text-sm text-muted-foreground">
              Share of assistant replies answered instantly with no LLM call.
            </p>
          </div>
        </div>
      </Card>

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {INSIGHT_CARDS.map((config) => {
          const Icon = config.icon;
          return (
            <Card key={config.label} className="p-4">
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${config.bgColor}`}>
                  <Icon className={`h-5 w-5 ${config.iconColor}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground">
                    {config.label}
                  </p>
                  {isLoading || !data ? (
                    <Skeleton className="h-7 w-16 mt-1" />
                  ) : (
                    <>
                      <p className="text-2xl font-bold">{config.value(data)}</p>
                      {config.hint && (
                        <p className="text-xs text-muted-foreground">
                          {config.hint(data)}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </Card>
          );
        })}

        {/* Feedback (combined 👍/👎) */}
        <Card className="p-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-teal-100 dark:bg-teal-900/30">
              <ThumbsUp className="h-5 w-5 text-teal-600 dark:text-teal-400" />
            </div>
            <div className="min-w-0">
              <p className="text-sm text-muted-foreground">Message feedback</p>
              {isLoading || !data ? (
                <Skeleton className="h-7 w-20 mt-1" />
              ) : (
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1 text-2xl font-bold">
                    <ThumbsUp className="h-4 w-4 text-green-600 dark:text-green-400" />
                    {data.feedbackUp}
                  </span>
                  <span className="flex items-center gap-1 text-2xl font-bold">
                    <ThumbsDown className="h-4 w-4 text-red-600 dark:text-red-400" />
                    {data.feedbackDown}
                  </span>
                </div>
              )}
            </div>
          </div>
        </Card>
      </div>

      <BotAnalyticsSection />

      <OpsInsightsSection />
    </PageShell>
  );
}
