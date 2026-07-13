'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, AlertCircle, Search } from 'lucide-react';
import { usePricebook, useTaxRates } from '@/hooks/use-pricebook';
import { PricebookTable } from '@/components/admin/pricebook/pricebook-table';
import { PricebookFormDialog } from '@/components/admin/pricebook/pricebook-form-dialog';
import { TaxRatesPanel } from '@/components/admin/pricebook/tax-rates-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { pageLabel } from '@/lib/admin/invoice-list-helpers';
import type { PricebookItem } from '@/hooks/use-pricebook';

const ALL_TYPES = 'all';
const PER_PAGE = 50;

export default function PricebookPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>(ALL_TYPES);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [laborOnly, setLaborOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PricebookItem | null>(null);

  // Debounce the search box so browsing fires one request per pause, not per key.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const typeParam = typeFilter === ALL_TYPES ? undefined : typeFilter;

  const { items, total, types, isLoading, error, refetch } = usePricebook({
    page,
    search: debouncedSearch,
    type: typeParam,
    includeInactive,
    isLaborItem: laborOnly,
  });

  const { taxRates, isLoading: taxLoading, refetch: refetchTax } = useTaxRates();

  // Reset to page 1 whenever the query (search / type / toggles) changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, typeFilter, includeInactive, laborOnly]);

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  function handleAddClick(): void {
    setEditing(null);
    setFormOpen(true);
  }

  function handleEditClick(item: PricebookItem): void {
    setEditing(item);
    setFormOpen(true);
  }

  async function handleDeactivate(item: PricebookItem): Promise<void> {
    const res = await fetch(`/api/admin/pricebook/${item.id}`, {
      method: 'DELETE',
    });
    if (res.ok) void refetch();
  }

  const handleRefetchAll = useCallback(() => {
    void refetch();
    void refetchTax();
  }, [refetch, refetchTax]);

  return (
    <PageShell>
      <PageHeader
        title="Pricebook"
        subtitle="Manage priced services, materials, equipment, and tax rates."
        actions={
          <Button onClick={handleAddClick}>
            <Plus className="mr-2 h-4 w-4" />
            Add Item
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 sm:max-w-md">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Search pricebook"
            placeholder="Search by name, SKU, or description..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? ALL_TYPES)}>
          <SelectTrigger aria-label="Filter by type" className="w-[160px]">
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TYPES}>All types</SelectItem>
            {types.map((t) => (
              <SelectItem key={t} value={t} className="capitalize">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant={includeInactive ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setIncludeInactive((v) => !v)}
          aria-pressed={includeInactive}
        >
          Show inactive
        </Button>
        <Button
          type="button"
          variant={laborOnly ? 'secondary' : 'outline'}
          size="sm"
          onClick={() => setLaborOnly((v) => !v)}
          aria-pressed={laborOnly}
        >
          Labor only
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <PricebookTable
        items={items}
        isLoading={isLoading}
        onEdit={handleEditClick}
        onDeactivate={(item) => void handleDeactivate(item)}
      />

      {/* pager bar — only shown when there are results */}
      {total > 0 && (
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
      )}

      <Separator />

      <TaxRatesPanel
        taxRates={taxRates}
        isLoading={taxLoading}
        onChanged={handleRefetchAll}
      />

      <PricebookFormDialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        onSuccess={() => void refetch()}
        editing={editing}
      />
    </PageShell>
  );
}
