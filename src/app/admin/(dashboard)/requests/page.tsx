'use client';

import { useState, useEffect } from 'react';
import { AlertCircle, Search } from 'lucide-react';
import { useAdminRequests } from '@/hooks/use-admin-requests';
import { StatsCards } from '@/components/admin/stats-cards';
import { RequestFilters } from '@/components/admin/request-filters';
import { RequestTable } from '@/components/admin/request-table';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { pageLabel } from '@/lib/admin/invoice-list-helpers';
import type { RequestSortKey } from '@/lib/admin/types';

const PER_PAGE = 50;

export default function AdminRequestsPage() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [urgencyFilter, setUrgencyFilter] = useState<string>('');
  const [assignedToFilter, setAssignedToFilter] = useState<string>('');
  const [isAfterHoursFilter, setIsAfterHoursFilter] = useState<boolean>(false);
  const [sortKey, setSortKey] = useState<RequestSortKey>('newest');
  const [searchInput, setSearchInput] = useState<string>('');
  const [debouncedSearch, setDebouncedSearch] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(searchInput.trim()), 300);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // Reset to page 1 whenever filters, sort, or search change.
  useEffect(() => {
    setPage(1);
  }, [statusFilter, urgencyFilter, assignedToFilter, isAfterHoursFilter, debouncedSearch, sortKey]);

  const { requests, total, isLoading, error, refetch } = useAdminRequests({
    status: statusFilter || undefined,
    search: debouncedSearch || undefined,
    urgency: urgencyFilter || undefined,
    assignedTo: assignedToFilter || undefined,
    isAfterHours: isAfterHoursFilter || undefined,
    sort: sortKey,
    page,
    limit: PER_PAGE,
  });

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  return (
    <PageShell>
      <PageHeader
        title="Service Requests"
        actions={<span className="text-sm text-muted-foreground">{total} total</span>}
      />

      <StatsCards />

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-3">
        <RequestFilters
          currentStatus={statusFilter}
          onStatusChange={setStatusFilter}
          currentUrgency={urgencyFilter}
          onUrgencyChange={setUrgencyFilter}
          currentAssignedTo={assignedToFilter}
          onAssignedToChange={setAssignedToFilter}
          isAfterHours={isAfterHoursFilter}
          onAfterHoursChange={setIsAfterHoursFilter}
          currentSort={sortKey}
          onSortChange={setSortKey}
        />
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

      {/* Pager bar */}
      <div className="flex items-center justify-between px-1 py-3 text-sm">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={safePage <= 1}
        >
          ← Prev
        </Button>
        <span className="tabular-nums text-xs text-muted-foreground">
          {pageLabel(safePage, total, PER_PAGE)}
        </span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPage(1)}
            disabled={safePage <= 1}
          >
            First
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setPage(totalPages)}
            disabled={safePage >= totalPages}
          >
            Last
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={safePage >= totalPages}
          >
            Next →
          </Button>
        </div>
      </div>

      <RequestDetailSheet
        requestId={selectedRequestId}
        onClose={() => setSelectedRequestId(null)}
        onAssigned={refetch}
      />
    </PageShell>
  );
}
