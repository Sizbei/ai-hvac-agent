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
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { OpsInsightsSection } from '@/components/admin/insights/ops-insights-section';
import { BotAnalyticsSection } from '@/components/admin/insights/bot-analytics-section';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { StatCard } from '@/components/admin/ui/stat-card';
import { adminFetch, AdminAuthRedirectError } from '@/lib/admin/admin-fetch';

interface InsightCard {
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  readonly intent: 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  readonly value: (data: AiInsights) => string;
  readonly sublabel?: (data: AiInsights) => string;
}

const INSIGHT_CARDS: readonly InsightCard[] = [
  {
    label: 'Total conversations',
    icon: MessagesSquare,
    intent: 'info',
    value: (d) => String(d.totalSessions),
  },
  {
    label: 'Requests created',
    icon: ClipboardList,
    intent: 'success',
    value: (d) => String(d.submittedRequests),
    sublabel: (d) => `${d.conversionRate}% conversion`,
  },
  {
    label: 'Escalated',
    icon: AlertTriangle,
    intent: 'warning',
    value: (d) => String(d.escalatedSessions),
  },
  {
    label: 'Abandoned',
    icon: Ban,
    intent: 'danger',
    value: (d) => String(d.abandonedSessions),
  },
  {
    label: 'Instant vs AI replies',
    icon: Cpu,
    intent: 'neutral',
    value: (d) => `${d.deterministicReplies} / ${d.llmReplies}`,
    sublabel: () => 'instant / AI assistant turns',
  },
  {
    label: 'Total AI tokens used',
    icon: Coins,
    intent: 'neutral',
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
      const res = await adminFetch('/api/admin/ai-insights');

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
    } catch (err) {
      if (err instanceof AdminAuthRedirectError) return;
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

      {/* Headline: deflection rate — hero card gets extra padding + tint */}
      <StatCard
        label="Deflection rate"
        value={isLoading || !data ? '—' : `${data.deflectionRate}%`}
        icon={Zap}
        intent="primary"
        size="lg"
        loading={isLoading}
        sublabel="Share of assistant replies answered instantly with no AI call."
        className="p-6"
      />

      {/* Metric cards */}
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {INSIGHT_CARDS.map((config) => {
          const Icon = config.icon as React.ComponentType<{ className?: string }> & { displayName?: string };
          return (
            <StatCard
              key={config.label}
              label={config.label}
              value={data ? config.value(data) : '—'}
              icon={Icon as Parameters<typeof StatCard>[0]['icon']}
              intent={config.intent}
              size="sm"
              loading={isLoading}
              sublabel={data && config.sublabel ? config.sublabel(data) : undefined}
            />
          );
        })}

        {/* Feedback (combined 👍/👎) */}
        <StatCard
          label="Message feedback"
          value={isLoading || !data ? '—' : `${data.feedbackUp} / ${data.feedbackDown}`}
          icon={ThumbsUp}
          intent="success"
          size="sm"
          loading={isLoading}
          sublabel={data ? `${data.feedbackUp} helpful · ${data.feedbackDown} not helpful` : undefined}
        />
      </div>

      <BotAnalyticsSection />

      <OpsInsightsSection />
    </PageShell>
  );
}
