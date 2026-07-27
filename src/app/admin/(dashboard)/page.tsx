'use client';

import { useState } from 'react';
import { AlertCircle, CalendarClock, Siren, PauseCircle } from 'lucide-react';
import { useDashboardOverview } from '@/hooks/use-dashboard-overview';
import { DashboardGreeting } from '@/components/admin/dashboard/dashboard-greeting';
import { DashboardStatCards } from '@/components/admin/dashboard/dashboard-stat-cards';
import { DashboardListCard } from '@/components/admin/dashboard/dashboard-list-card';
import { RecentConversationsCard } from '@/components/admin/dashboard/recent-conversations-card';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { OnboardingChecklist } from '@/components/admin/onboarding/onboarding-checklist';
import { PageShell } from '@/components/admin/ui/page-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function AdminDashboardPage() {
  const { overview, isLoading, error, refetch } = useDashboardOverview();
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  return (
    <PageShell>
      <DashboardGreeting />

      <OnboardingChecklist />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DashboardStatCards stats={overview?.stats ?? null} isLoading={isLoading} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Left: priority lists */}
        <div className="space-y-6 lg:col-span-2">
          <DashboardListCard
            title="Today's schedule"
            icon={CalendarClock}
            intent="info"
            requests={overview?.todaySchedule ?? []}
            isLoading={isLoading}
            emptyLabel="No jobs scheduled for today."
            meta="arrivalWindow"
            onSelect={setSelectedRequestId}
          />

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <DashboardListCard
              title="Needs attention"
              icon={Siren}
              intent="danger"
              requests={overview?.needsAttention ?? []}
              isLoading={isLoading}
              emptyLabel="No unassigned urgent requests."
              meta="arrivalWindow"
              onSelect={setSelectedRequestId}
            />
            <DashboardListCard
              title="Awaiting follow-up"
              icon={PauseCircle}
              intent="neutral"
              requests={overview?.awaitingFollowUp ?? []}
              isLoading={isLoading}
              emptyLabel="No on-hold jobs awaiting follow-up."
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
