'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  AlertCircle,
  CalendarClock,
  ChevronRight,
  MessagesSquare,
  Siren,
  PauseCircle,
} from 'lucide-react';
import { useDashboardOverview } from '@/hooks/use-dashboard-overview';
import type { DashboardOverviewWithOverdue } from '@/lib/admin/queries';
import { DashboardGreeting } from '@/components/admin/dashboard/dashboard-greeting';
import { DashboardStatCards } from '@/components/admin/dashboard/dashboard-stat-cards';
import { DashboardListCard } from '@/components/admin/dashboard/dashboard-list-card';
import { RecentConversationsCard } from '@/components/admin/dashboard/recent-conversations-card';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { SetupCard } from '@/components/admin/onboarding/setup-card';
import { PageShell } from '@/components/admin/ui/page-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { dashboardSectionState, needsActionLabel } from '@/lib/admin/dashboard-display';
import { NEEDS_ACTION_INBOX_HREF } from '@/lib/admin/conversation-display';

/** Escalated conversations above the Needs attention list (they are not requests). */
function ConversationsNeedingActionRow({ count }: { readonly count: number }) {
  return (
    <Link
      href={NEEDS_ACTION_INBOX_HREF}
      className="mb-1 flex items-center gap-3 rounded-[3px] px-2 py-2 transition-colors hover:bg-row-hover"
    >
      <MessagesSquare className="size-4 shrink-0 text-danger-strong" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{needsActionLabel(count)}</div>
        <div className="truncate text-xs text-muted-foreground">
          Escalated and not handled yet
        </div>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </Link>
  );
}

export default function AdminDashboardPage() {
  const { overview, isLoading, error, refetch } = useDashboardOverview();
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  // The /api/admin/overview payload carries overdueInvoices (Rdashboard-2) even
  // though the shared DashboardOverview type (used by the polling hook) doesn't
  // declare it — DashboardOverviewWithOverdue is the query layer's local
  // extension for that one extra field.
  const overdueInvoices =
    (overview as DashboardOverviewWithOverdue | null)?.overdueInvoices ?? null;
  // A failed load with nothing on screen is an error in every section, never
  // "All clear" or zeros.
  const state = dashboardSectionState({ isLoading, hasData: overview !== null, failed: error !== null });
  const retry = () => void refetch();
  const conversationsNeedingAction = overview?.conversationsNeedingAction ?? 0;

  return (
    <PageShell>
      <DashboardGreeting />

      <SetupCard />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span>
              {overview
                ? `${error} Showing what loaded last.`
                : error}
            </span>
            <Button variant="outline" size="sm" onClick={retry} disabled={isLoading}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <DashboardStatCards
        stats={overview?.stats ?? null}
        overdueInvoices={overdueInvoices}
        conversationsNeedingAction={overview ? conversationsNeedingAction : null}
        isLoading={isLoading}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left: priority lists */}
        <div className="space-y-6 lg:col-span-2">
          <DashboardListCard
            title="Today's schedule"
            icon={CalendarClock}
            intent="info"
            requests={overview?.todaySchedule ?? []}
            state={state}
            onRetry={retry}
            emptyLabel="No requests scheduled for today."
            meta="arrivalWindow"
            onSelect={setSelectedRequestId}
          />

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <DashboardListCard
              title="Needs attention"
              icon={Siren}
              intent="danger"
              requests={overview?.needsAttention ?? []}
              state={state}
              onRetry={retry}
              leading={
                conversationsNeedingAction > 0 ? (
                  <ConversationsNeedingActionRow count={conversationsNeedingAction} />
                ) : undefined
              }
              leadingCount={conversationsNeedingAction}
              emptyLabel="No unassigned urgent requests."
              meta="arrivalWindow"
              onSelect={setSelectedRequestId}
            />
            <DashboardListCard
              title="Awaiting follow-up"
              icon={PauseCircle}
              intent="neutral"
              requests={overview?.awaitingFollowUp ?? []}
              state={state}
              onRetry={retry}
              emptyLabel="No on-hold requests awaiting follow-up."
              meta="followUp"
              onSelect={setSelectedRequestId}
            />
          </div>
        </div>

        {/* Right: recent conversations feed */}
        <RecentConversationsCard />
      </div>

      <RequestDetailSheet
        requestId={selectedRequestId}
        onClose={() => setSelectedRequestId(null)}
        onAssigned={refetch}
      />
    </PageShell>
  );
}
