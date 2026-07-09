'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Archive,
  Building2,
  Calendar,
  RefreshCw,
  Search,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminCustomers } from '@/hooks/use-admin-customers';
import { CustomerFormDialog } from '@/components/admin/customer-form-dialog';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { paginate, pageLabel } from '@/lib/admin/invoice-list-helpers';
import type { CustomerListRecord } from '@/lib/admin/crm-types';

const ALL_PROPERTY_TYPES = 'all';
const PER_PAGE = 50;

// ── CustomerRow ────────────────────────────────────────────────────────────────

interface CustomerRowProps {
  customer: CustomerListRecord;
}

const CustomerRow = memo(function CustomerRow({ customer }: CustomerRowProps) {
  return (
    <Link href={`/admin/customers/${customer.id}`}>
      <Card className="transition-colors hover:bg-muted/50">
        <CardContent className="flex items-center gap-4 p-4">
          <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Building2 className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate font-medium">
                {customer.name ?? 'Unknown'}
              </p>
              {customer.fieldpulseCustomerId && (
                <span className="rounded border bg-violet-50 px-1.5 py-px text-[10px] font-medium text-violet-700">
                  FieldPulse
                </span>
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
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <Wrench className="size-3.5" />
              {customer.equipmentCount}
            </span>
            <span className="flex items-center gap-1">
              <Calendar className="size-3.5" />
              {customer.requestCount}
            </span>
            {customer.lastServiceDate && (
              <Badge variant="outline" className="text-xs">
                Last: {new Date(customer.lastServiceDate).toLocaleDateString()}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
});

// ── Page ───────────────────────────────────────────────────────────────────────

export default function CustomersPage() {
  const [showArchived, setShowArchived] = useState(false);
  const { customers, isLoading, error, refetch } = useAdminCustomers(showArchived);
  const [search, setSearch] = useState('');
  const [propertyTypeFilter, setPropertyTypeFilter] = useState<string>(ALL_PROPERTY_TYPES);
  const [showCreate, setShowCreate] = useState(false);
  const [page, setPage] = useState(1);

  const propertyTypeOptions = useMemo(() => {
    const present = new Set<string>();
    for (const c of customers) {
      if (c.propertyType) present.add(c.propertyType);
    }
    return Array.from(present).sort((a, b) => a.localeCompare(b));
  }, [customers]);

  const filtered = useMemo(() => {
    return customers.filter((c) => {
      if (propertyTypeFilter !== ALL_PROPERTY_TYPES && c.propertyType !== propertyTypeFilter) {
        return false;
      }
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        c.name?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.includes(q) ||
        c.address?.toLowerCase().includes(q)
      );
    });
  }, [customers, search, propertyTypeFilter]);

  // Reset page when filters change
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    setPage(1);
  }, [search, propertyTypeFilter, showArchived]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(() => paginate(filtered, safePage, PER_PAGE), [filtered, safePage]);

  const isFiltered = Boolean(search) || propertyTypeFilter !== ALL_PROPERTY_TYPES;

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearch(e.target.value);
  }, []);

  const handlePropertyTypeChange = useCallback((value: string | null) => {
    setPropertyTypeFilter(value ?? ALL_PROPERTY_TYPES);
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
      <PageHeader
        title="Customers"
        subtitle={`${customers.length} customers`}
        actions={
          <Button onClick={handleShowCreate}>
            <UserPlus className="mr-2 size-4" />
            Add Customer
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search customers"
            placeholder="Search by name, email, phone, or address..."
            value={search}
            onChange={handleSearchChange}
            className="pl-10"
          />
        </div>
        <Select
          value={propertyTypeFilter}
          onValueChange={handlePropertyTypeChange}
        >
          <SelectTrigger aria-label="Filter by property type" className="w-[180px]">
            <SelectValue placeholder="Filter by property" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROPERTY_TYPES}>All property types</SelectItem>
            {propertyTypeOptions.map((type) => (
              <SelectItem key={type} value={type}>
                {type}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={showArchived ? 'default' : 'outline'}
          size="sm"
          onClick={handleToggleArchived}
        >
          <Archive className="mr-2 size-4" />
          {showArchived ? 'Hide Archived' : 'Show Archived'}
        </Button>
      </div>

      {isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <CardSkeleton key={i} />
          ))}
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
      ) : filtered.length === 0 ? (
        <Card className="p-5">
          <EmptyState
            icon={Users}
            title={isFiltered ? 'No customers match' : 'No customers yet'}
            description={
              isFiltered
                ? 'Try a different search term or property-type filter.'
                : 'Add your first customer to start tracking equipment, service history, and follow-ups.'
            }
            action={
              isFiltered ? undefined : (
                <Button onClick={handleShowCreate}>
                  <UserPlus className="mr-2 size-4" />
                  Add Customer
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          <div className="grid gap-3">
            {pageRows.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} />
            ))}
          </div>

          {/* pager bar */}
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
              {pageLabel(safePage, filtered.length, PER_PAGE)}
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
        </>
      )}

      <CustomerFormDialog
        open={showCreate}
        onOpenChange={handleCloseCreate}
        onSuccess={handleCreateSuccess}
      />
    </PageShell>
  );
}
