'use client';

import { useState } from 'react';
import { AlertCircle, CalendarClock, Siren, PauseCircle } from 'lucide-react';
import { useDashboardOverview } from '@/hooks/use-dashboard-overview';
import { DashboardStatCards } from '@/components/admin/dashboard/dashboard-stat-cards';
import { DashboardListCard } from '@/components/admin/dashboard/dashboard-list-card';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function AdminDashboardPage() {
  const { overview, isLoading, error, refetch } = useDashboardOverview();
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="font-heading text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Today&apos;s schedule and everything that needs attention.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DashboardStatCards stats={overview?.stats ?? null} isLoading={isLoading} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
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

      <RequestDetailSheet
        requestId={selectedRequestId}
        onClose={() => setSelectedRequestId(null)}
        onAssigned={refetch}
      />
    </div>
  );
}
