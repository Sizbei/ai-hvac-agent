'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { UserPlus, Search, Building2, Wrench, Calendar } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAdminCustomers } from '@/hooks/use-admin-customers';
import { CustomerFormDialog } from '@/components/admin/customer-form-dialog';

const ALL_PROPERTY_TYPES = 'all';

export default function CustomersPage() {
  const { customers, isLoading, refetch } = useAdminCustomers();
  const [search, setSearch] = useState('');
  const [propertyTypeFilter, setPropertyTypeFilter] = useState<string>(ALL_PROPERTY_TYPES);
  const [showCreate, setShowCreate] = useState(false);

  const propertyTypeOptions = useMemo(() => {
    const present = new Set<string>();
    for (const c of customers) {
      if (c.propertyType) present.add(c.propertyType);
    }
    return Array.from(present).sort((a, b) => a.localeCompare(b));
  }, [customers]);

  const filtered = useMemo(
    () =>
      customers.filter((c) => {
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
      }),
    [customers, search, propertyTypeFilter],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Customers</h1>
          <p className="text-sm text-muted-foreground">
            {customers.length} total customers
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <UserPlus className="mr-2 size-4" />
          Add Customer
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name, email, phone, or address..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select
          value={propertyTypeFilter}
          onValueChange={(value) => setPropertyTypeFilter(value ?? ALL_PROPERTY_TYPES)}
        >
          <SelectTrigger className="w-[180px]">
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
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          {search || propertyTypeFilter !== ALL_PROPERTY_TYPES
            ? 'No customers match your filters.'
            : 'No customers yet. Add your first customer to get started.'}
        </div>
      ) : (
        <div className="grid gap-3">
          {filtered.map((customer) => (
            <Link
              key={customer.id}
              href={`/admin/customers/${customer.id}`}
            >
              <Card className="transition-colors hover:bg-muted/50">
                <CardContent className="flex items-center gap-4 p-4">
                  <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Building2 className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {customer.name ?? 'Unknown'}
                    </p>
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
          ))}
        </div>
      )}

      <CustomerFormDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onSuccess={() => {
          setShowCreate(false);
          refetch();
        }}
      />
    </div>
  );
}
