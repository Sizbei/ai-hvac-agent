'use client';

import { useState, useEffect } from 'react';
import { AlertCircle, Search } from 'lucide-react';
import { useAdminRequests } from '@/hooks/use-admin-requests';
import { StatsCards } from '@/components/admin/stats-cards';
import { RequestFilters } from '@/components/admin/request-filters';
import { RequestTable } from '@/components/admin/request-table';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';

export default function AdminRequestsPage() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [searchInput, setSearchInput] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const { requests, total, isLoading, error, refetch } = useAdminRequests({
    status: statusFilter || undefined,
    search: debouncedSearch || undefined,
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

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <RequestFilters currentStatus={statusFilter} onStatusChange={setStatusFilter} />
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by reference #"
            className="pl-9"
            aria-label="Search requests by reference number"
          />
        </div>
      </div>

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
