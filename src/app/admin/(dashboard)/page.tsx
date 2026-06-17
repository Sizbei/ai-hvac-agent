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
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function AdminDashboardPage() {
  const { overview, isLoading, error, refetch } = useDashboardOverview();
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-[1280px] space-y-7 p-6 sm:p-7">
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
            iconColor="text-sky-600 dark:text-sky-400"
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
              iconColor="text-red-600 dark:text-red-400"
              requests={overview?.needsAttention ?? []}
              isLoading={isLoading}
              emptyLabel="No unassigned urgent requests."
              meta="arrivalWindow"
              onSelect={setSelectedRequestId}
            />
            <DashboardListCard
              title="Awaiting follow-up"
              icon={PauseCircle}
              iconColor="text-slate-600 dark:text-slate-300"
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
    </div>
  );
}
