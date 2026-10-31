'use client';

import { useState, useEffect, useCallback } from 'react';
import { useUrlFilterSync } from '@/hooks/use-url-filter-sync';
import { AlertCircle, Plus, Search } from 'lucide-react';
import { useAdminRequests } from '@/hooks/use-admin-requests';
import { RequestFilters } from '@/components/admin/request-filters';
import { RequestTable } from '@/components/admin/request-table';
import { RequestDetailSheet } from '@/components/admin/request-detail-sheet';
import { RequestCreateDialog } from '@/components/admin/request-create-dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { Pager } from '@/components/admin/ui/pager';
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
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => { document.title = 'Requests · Spears Admin'; }, []);

  // Persist filters to the URL (shareable links + survives refresh). Page and
  // the detail sheet selection are intentionally NOT persisted. Defaults map to
  // '' so they're dropped from the URL.
  const urlFilterState = {
    status: statusFilter,
    urgency: urgencyFilter,
    assignedTo: assignedToFilter,
    afterHours: isAfterHoursFilter ? '1' : '',
    sort: sortKey === 'newest' ? '' : sortKey,
    q: searchInput,
  };
  const restoreFiltersFromUrl = useCallback((p: Record<string, string>) => {
    const statuses: readonly string[] = ['pending', 'scheduled', 'assigned', 'in_progress', 'on_hold', 'completed', 'cancelled'];
    const urgencies: readonly string[] = ['low', 'medium', 'high', 'emergency'];
    const sorts: readonly string[] = ['newest', 'oldest', 'urgency'];
    if (p.status && statuses.includes(p.status)) setStatusFilter(p.status);
    if (p.urgency && urgencies.includes(p.urgency)) setUrgencyFilter(p.urgency);
    // assignedTo is a free UUID — persist as-is (server already UUID-guards it)
    if (p.assignedTo) setAssignedToFilter(p.assignedTo);
    if (p.afterHours === '1') setIsAfterHoursFilter(true);
    if (p.sort && sorts.includes(p.sort)) setSortKey(p.sort as RequestSortKey);
    if (p.q) { setSearchInput(p.q); setDebouncedSearch(p.q); }
  }, []);
  useUrlFilterSync(urlFilterState, restoreFiltersFromUrl);

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
        title="Service requests"
        actions={
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{total} total</span>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              New request
            </Button>
          </div>
        }
      />

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
        hasActiveFilters={
          !!statusFilter || !!urgencyFilter || !!assignedToFilter || !!debouncedSearch || isAfterHoursFilter
        }
        onClearFilters={() => {
          setStatusFilter('');
          setUrgencyFilter('');
          setAssignedToFilter('');
          setIsAfterHoursFilter(false);
          setSearchInput('');
          setDebouncedSearch('');
        }}
      />

      <Pager
        page={safePage}
        totalPages={totalPages}
        total={total}
        perPage={PER_PAGE}
        onPageChange={setPage}
        showFirstLast
      />

      <RequestCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => {
          void refetch();
          setSelectedRequestId(id);
        }}
      />

      <RequestDetailSheet
        requestId={selectedRequestId}
        onClose={() => setSelectedRequestId(null)}
        onAssigned={refetch}
      />
    </PageShell>
  );
}
