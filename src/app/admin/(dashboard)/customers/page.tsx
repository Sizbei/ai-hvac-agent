'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useUrlFilterSync } from '@/hooks/use-url-filter-sync';
import Link from 'next/link';
import {
  Archive,
  Building2,
  Calendar,
  LayoutGrid,
  List as ListIcon,
  RefreshCw,
  Search,
  User,
  UserPlus,
  Users,
  Wrench,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { CardSkeleton } from '@/components/admin/skeletons';
import { Skeleton } from '@/components/ui/skeleton';
import { humanizeCode } from '@/lib/admin/display-labels';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminCustomers } from '@/hooks/use-admin-customers';
import { CustomerFormDialog } from '@/components/admin/customer-form-dialog';
import { CustomerPeopleCards } from '@/components/admin/customers/customer-people-cards';
import { CustomerDrawer } from '@/components/admin/customers/customer-drawer';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { BackToTourStrip } from '@/components/admin/setup/back-to-tour-strip';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { Pager } from '@/components/admin/ui/pager';
import { SyncPill } from '@/components/admin/sync-pill';
import type { CustomerListRecord } from '@/lib/admin/crm-types';
import { useAdminPageTitle } from '@/components/admin/org-name-context';

const ALL_PROPERTY_TYPES = 'all';
const ALL_CUSTOMER_TYPES = 'all';
const ALL_MEMBERSHIP_STATUSES = 'all';
const PER_PAGE = 50;

// ── CustomerRow ────────────────────────────────────────────────────────────────

interface CustomerRowProps {
  customer: CustomerListRecord;
}

const CustomerRow = memo(function CustomerRow({ customer }: CustomerRowProps) {
  return (
    <Link href={`/admin/customers/${customer.id}`}>
      <Card className="transition-colors hover:bg-row-hover">
        <CardContent className="flex items-center gap-4 px-4 py-2.5">
          <div className="flex size-9 items-center justify-center rounded-[4px] bg-primary-soft text-marker-strong">
            {customer.customerType === 'commercial' ? (
              <Building2 className="size-5" aria-hidden="true" />
            ) : (
              <User className="size-5" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">
                {customer.name ?? 'Unknown'}
              </p>
              {customer.fieldpulseCustomerId && (
                <SyncPill source="fieldpulse" size="md" />
              )}
              {customer.archivedAt && (
                <Badge variant="outline" className="text-xs">
                  Archived
                </Badge>
              )}
            </div>
            <p className="truncate text-sm text-muted-foreground">
              {customer.address ?? customer.email ?? customer.phone ?? 'No contact info'}
            </p>
          </div>
          <div className="hidden items-center gap-4 text-sm text-muted-foreground sm:flex">
            <span className="flex items-center gap-1.5">
              <Calendar className="size-3.5 text-foreground-faint" aria-hidden="true" />
              <span className="font-mono tabular-nums text-foreground">{customer.requestCount}</span>
              request{customer.requestCount === 1 ? '' : 's'}
            </span>
            <span className="flex items-center gap-1.5">
              <Wrench className="size-3.5 text-foreground-faint" aria-hidden="true" />
              <span className="font-mono tabular-nums">{customer.equipmentCount}</span>
              equipment
            </span>
            {customer.lastServiceDate && (
              <span className="text-xs">
                Last service {new Date(customer.lastServiceDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
});

// ── Page ───────────────────────────────────────────────────────────────────────

export default function CustomersPage() {
  useAdminPageTitle('Customers');
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [propertyTypeFilter, setPropertyTypeFilter] = useState<string>(ALL_PROPERTY_TYPES);
  const [customerTypeFilter, setCustomerTypeFilter] = useState<string>(ALL_CUSTOMER_TYPES);
  const [membershipStatusFilter, setMembershipStatusFilter] = useState<string>(ALL_MEMBERSHIP_STATUSES);
  const [fieldpulseSyncedFilter, setFieldpulseSyncedFilter] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'cards' | 'list'>(() => {
    try {
      return localStorage.getItem('customers:view') === 'list' ? 'list' : 'cards';
    } catch {
      return 'cards';
    }
  });
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);

  // Persist filters to the URL (shareable links + survives refresh). Page, view
  // mode, and ephemeral UI (drawer selection) are intentionally NOT persisted.
  // Defaults map to '' so they're dropped from the URL.
  const urlFilterState = {
    q: search,
    propertyType: propertyTypeFilter === ALL_PROPERTY_TYPES ? '' : propertyTypeFilter,
    customerType: customerTypeFilter === ALL_CUSTOMER_TYPES ? '' : customerTypeFilter,
    membership: membershipStatusFilter === ALL_MEMBERSHIP_STATUSES ? '' : membershipStatusFilter,
    fpSynced: fieldpulseSyncedFilter ? '1' : '',
    archived: showArchived ? '1' : '',
  };
  const restoreFiltersFromUrl = useCallback((p: Record<string, string>) => {
    const customerTypes: readonly string[] = ['residential', 'commercial'];
    const membershipStatuses: readonly string[] = ['none', 'active', 'suspended', 'expired', 'cancelled'];
    if (p.q) { setSearch(p.q); setDebouncedSearch(p.q); }
    // propertyType is a free string from the DB — persist as-is (no finite enum)
    if (p.propertyType) setPropertyTypeFilter(p.propertyType);
    if (p.customerType && customerTypes.includes(p.customerType)) setCustomerTypeFilter(p.customerType);
    if (p.membership && membershipStatuses.includes(p.membership)) setMembershipStatusFilter(p.membership);
    if (p.fpSynced === '1') setFieldpulseSyncedFilter(true);
    if (p.archived === '1') setShowArchived(true);
  }, []);
  useUrlFilterSync(urlFilterState, restoreFiltersFromUrl);
  // The list waits until the URL filters are read (the effect above, which runs
  // first), so `?q=Summit` never flashes the unfiltered list. A bare URL is
  // ready at once and keeps the cached rows on Back.
  const [urlRead, setUrlRead] = useState(
    () => typeof window !== 'undefined' && window.location.search === '',
  );
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setUrlRead(true), []);

  // Debounce the search box so browsing fires one request per pause, not per key.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const propertyType =
    propertyTypeFilter === ALL_PROPERTY_TYPES ? null : propertyTypeFilter;
  const customerType =
    customerTypeFilter === ALL_CUSTOMER_TYPES ? null : customerTypeFilter;
  const membershipStatus =
    membershipStatusFilter === ALL_MEMBERSHIP_STATUSES ? null : membershipStatusFilter;

  // Server-paginated: the hook returns only the current page plus the total and
  // the distinct property types for the filter dropdown.
  const { customers, total, propertyTypes, isLoading, error, refetch } =
    useAdminCustomers({
      includeArchived: showArchived,
      page,
      search: debouncedSearch,
      propertyType,
      customerType,
      membershipStatus,
      fieldpulseSynced: fieldpulseSyncedFilter,
      enabled: urlRead,
    });

  const setViewPersisted = useCallback((next: 'cards' | 'list') => {
    setView(next);
    try {
      localStorage.setItem('customers:view', next);
    } catch {
      // ignore storage failures (private mode)
    }
  }, []);

  const propertyTypeOptions = propertyTypes;

  // Reset to page 1 whenever the query (search / filter / archived) changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, propertyTypeFilter, customerTypeFilter, membershipStatusFilter, fieldpulseSyncedFilter, showArchived]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageRows = customers; // the server already returns just this page

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === selectedCustomerId) ?? null,
    [customers, selectedCustomerId],
  );

  const isFiltered =
    Boolean(debouncedSearch) ||
    propertyTypeFilter !== ALL_PROPERTY_TYPES ||
    customerTypeFilter !== ALL_CUSTOMER_TYPES ||
    membershipStatusFilter !== ALL_MEMBERSHIP_STATUSES ||
    fieldpulseSyncedFilter;

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
  }, []);

  const handlePropertyTypeChange = useCallback((value: string | null) => {
    setPropertyTypeFilter(value ?? ALL_PROPERTY_TYPES);
  }, []);

  const handleCustomerTypeChange = useCallback((value: string | null) => {
    setCustomerTypeFilter(value ?? ALL_CUSTOMER_TYPES);
  }, []);

  const handleMembershipStatusChange = useCallback((value: string | null) => {
    setMembershipStatusFilter(value ?? ALL_MEMBERSHIP_STATUSES);
  }, []);

  const handleToggleFieldpulseSynced = useCallback(() => {
    setFieldpulseSyncedFilter((prev) => !prev);
  }, []);

  const handleToggleArchived = useCallback(() => {
    setShowArchived((prev) => !prev);
  }, []);

  const handleShowCreate = useCallback(() => {
    setShowCreate(true);
  }, []);

  const handleCloseCreate = useCallback((open: boolean) => {
    setShowCreate(open);
  }, []);

  const handleCreateSuccess = useCallback(() => {
    setShowCreate(false);
    refetch();
  }, [refetch]);

  return (
    <PageShell>
      <BackToTourStrip />
      <PageHeader
        title="Customers"
        subtitle={
          isLoading
            ? 'Loading…'
            : error
              ? undefined
              : `${total} customer${total === 1 ? '' : 's'}`
        }
        actions={
          <Button onClick={handleShowCreate}>
            <UserPlus className="mr-2 size-4" />
            Add customer
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-auto sm:min-w-[300px] sm:max-w-md sm:flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search customers"
            placeholder="Search name, phone, email or address…"
            value={search}
            onChange={handleSearchChange}
            className="pl-10"
          />
        </div>
        <Select
          value={propertyTypeFilter}
          onValueChange={handlePropertyTypeChange}
        >
          <SelectTrigger aria-label="Filter by property type" className="w-[calc(50%-6px)] sm:w-[180px]">
            <SelectValue placeholder="Filter by property" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROPERTY_TYPES}>All property types</SelectItem>
            {propertyTypeOptions.map((type) => (
              <SelectItem key={type} value={type}>
                {humanizeCode(type)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={customerTypeFilter}
          onValueChange={handleCustomerTypeChange}
        >
          <SelectTrigger aria-label="Filter by customer type" className="w-[calc(50%-6px)] sm:w-[160px]">
            <SelectValue placeholder="Customer type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CUSTOMER_TYPES}>All customer types</SelectItem>
            <SelectItem value="residential">Residential</SelectItem>
            <SelectItem value="commercial">Commercial</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={membershipStatusFilter}
          onValueChange={handleMembershipStatusChange}
        >
          <SelectTrigger aria-label="Filter by membership status" className="w-[calc(50%-6px)] sm:w-[180px]">
            <SelectValue placeholder="Membership status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_MEMBERSHIP_STATUSES}>All memberships</SelectItem>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant={fieldpulseSyncedFilter ? 'default' : 'outline'}
          size="sm"
          onClick={handleToggleFieldpulseSynced}
          aria-pressed={fieldpulseSyncedFilter}
          aria-label="Show only customers synced from FieldPulse"
        >
          Synced from FieldPulse
        </Button>
        <Button
          variant={showArchived ? 'default' : 'outline'}
          size="sm"
          onClick={handleToggleArchived}
        >
          <Archive className="mr-2 size-4" />
          {showArchived ? 'Hide archived' : 'Show archived'}
        </Button>
        <div className="flex items-center rounded-lg border p-0.5">
          <Button
            variant={view === 'cards' ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label="Card view"
            aria-pressed={view === 'cards'}
            onClick={() => setViewPersisted('cards')}
          >
            <LayoutGrid className="size-4" />
          </Button>
          <Button
            variant={view === 'list' ? 'secondary' : 'ghost'}
            size="icon-sm"
            aria-label="List view"
            aria-pressed={view === 'list'}
            onClick={() => setViewPersisted('list')}
          >
            <ListIcon className="size-4" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className={view === 'cards' ? 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3' : 'grid gap-3'}>
          {Array.from({ length: 6 }, (_, i) =>
            view === 'cards' ? (
              <Skeleton key={i} className="h-[178px] w-full rounded-[6px]" />
            ) : (
              <CardSkeleton key={i} />
            ),
          )}
        </div>
      ) : error ? (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertTitle>Couldn&apos;t load customers</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            <span>{error}</span>
            <Button
              variant="outline"
              size="sm"
              aria-label="Retry loading customers"
              onClick={() => void refetch()}
            >
              <RefreshCw className="mr-2 size-4" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : total === 0 ? (
        <Card className="p-5">
          <EmptyState
            icon={Users}
            title={isFiltered ? 'No customers match' : 'No customers yet'}
            description={
              isFiltered
                ? 'Try a different search or clear the filters. Phone numbers match in any format.'
                : 'Add your first customer to start tracking equipment, service history, and follow-ups.'
            }
            action={
              isFiltered ? undefined : (
                <Button onClick={handleShowCreate}>
                  <UserPlus className="mr-2 size-4" />
                  Add customer
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          {view === 'cards' ? (
            <CustomerPeopleCards
              customers={pageRows}
              onSelect={setSelectedCustomerId}
              selectedId={selectedCustomerId}
            />
          ) : (
            <div className="grid gap-3">
              {pageRows.map((customer) => (
                <CustomerRow key={customer.id} customer={customer} />
              ))}
            </div>
          )}

          <Pager
            page={safePage}
            totalPages={totalPages}
            total={total}
            perPage={PER_PAGE}
            onPageChange={setPage}
            showFirstLast
          />
        </>
      )}

      <CustomerFormDialog
        open={showCreate}
        onOpenChange={handleCloseCreate}
        onSuccess={handleCreateSuccess}
      />

      <CustomerDrawer
        customer={selectedCustomer}
        onClose={() => setSelectedCustomerId(null)}
      />
    </PageShell>
  );
}
