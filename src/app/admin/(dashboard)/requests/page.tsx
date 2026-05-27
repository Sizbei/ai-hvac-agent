'use client';

import { useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useAdminRequests } from '@/hooks/use-admin-requests';
import { StatsCards } from '@/components/admin/stats-cards';
import { RequestFilters } from '@/components/admin/request-filters';
import { RequestTable } from '@/components/admin/request-table';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function AdminRequestsPage() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  const { requests, total, isLoading, error, refetch } = useAdminRequests({
    status: statusFilter || undefined,
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Service Requests</h1>
        <span className="text-sm text-muted-foreground">{total} total</span>
      </div>

      <StatsCards />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <RequestFilters currentStatus={statusFilter} onStatusChange={setStatusFilter} />

      <RequestTable
        requests={requests}
        isLoading={isLoading}
        onRowClick={(req) => setSelectedRequestId(req.id)}
      />

      <RequestDetailSheet
        requestId={selectedRequestId}
        onClose={() => setSelectedRequestId(null)}
        onAssigned={refetch}
      />
    </div>
  );
}
