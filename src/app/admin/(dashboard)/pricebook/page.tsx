'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, AlertCircle, Search } from 'lucide-react';
import { usePricebook, useTaxRates, type PricebookSortKey } from '@/hooks/use-pricebook';
import { useUrlFilterSync } from '@/hooks/use-url-filter-sync';
import { PricebookTable } from '@/components/admin/pricebook/pricebook-table';
import { PricebookFormDialog } from '@/components/admin/pricebook/pricebook-form-dialog';
import { TaxRatesPanel } from '@/components/admin/pricebook/tax-rates-panel';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
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

const PRICEBOOK_SORT_OPTIONS: ReadonlyArray<{ value: PricebookSortKey; label: string }> = [
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'price_asc', label: 'Price (low–high)' },
  { value: 'price_desc', label: 'Price (high–low)' },
];

export default function PricebookPage() {
  useEffect(() => { document.title = 'Pricebook · Spears Admin'; }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>(ALL_TYPES);
  const [sortKey, setSortKey] = useState<PricebookSortKey>('name');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [laborOnly, setLaborOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PricebookItem | null>(null);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  const [pendingDeactivate, setPendingDeactivate] = useState<PricebookItem | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);

  // Persist filters to the URL (shareable links + survives refresh). Page is
  // intentionally NOT persisted. Defaults map to '' so they're dropped from the URL.
  const urlFilterState = {
    q: search,
    type: typeFilter === ALL_TYPES ? '' : typeFilter,
    sort: sortKey === 'name' ? '' : sortKey,
    inactive: includeInactive ? '1' : '',
    labor: laborOnly ? '1' : '',
  };
  const restoreFiltersFromUrl = useCallback((p: Record<string, string>) => {
    const sorts: readonly string[] = ['name', 'price_asc', 'price_desc'];
    const validTypes: readonly string[] = ['service', 'material', 'equipment'];
    if (p.q) { setSearch(p.q); setDebouncedSearch(p.q); }
    if (p.type && validTypes.includes(p.type)) setTypeFilter(p.type);
    if (p.sort && sorts.includes(p.sort)) setSortKey(p.sort as PricebookSortKey);
    if (p.inactive === '1') setIncludeInactive(true);
    if (p.labor === '1') setLaborOnly(true);
  }, []);
  useUrlFilterSync(urlFilterState, restoreFiltersFromUrl);

  // Debounce the search box so browsing fires one request per pause, not per key.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // `/` shortcut: focus the search input (when not already in a text field).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      const target = e.target as HTMLElement;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const typeParam = typeFilter === ALL_TYPES ? undefined : typeFilter;

  const { items, total, types, isLoading, error, refetch } = usePricebook({
    page,
    search: debouncedSearch,
    type: typeParam,
    includeInactive,
    isLaborItem: laborOnly,
    sort: sortKey,
  });

  const { taxRates, isLoading: taxLoading, refetch: refetchTax } = useTaxRates();

  // Reset to page 1 whenever the query (search / type / sort / toggles) changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, typeFilter, sortKey, includeInactive, laborOnly]);

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

  async function handleDeactivateConfirm(): Promise<void> {
    if (!pendingDeactivate) return;
    setIsConfirming(true);
    setDeactivateError(null);
    try {
      const res = await fetch(`/api/admin/pricebook/${pendingDeactivate.id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setPendingDeactivate(null);
        void refetch();
      } else {
        const body = await res.json().catch(() => ({}));
        setDeactivateError((body as { error?: string }).error ?? 'Failed to deactivate item.');
      }
    } catch {
      setDeactivateError('Network error — could not deactivate item.');
    } finally {
      setIsConfirming(false);
    }
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
            ref={searchRef}
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
        <select
          value={sortKey}
          onChange={(e) => { setSortKey(e.target.value as PricebookSortKey); setPage(1); }}
          className="rounded-xl border bg-card px-3 py-2.5 text-sm font-semibold text-foreground shadow-sm outline-none focus:ring-1 focus:ring-ring"
        >
          {PRICEBOOK_SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
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
        onDeactivate={(item) => { setDeactivateError(null); setPendingDeactivate(item); }}
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

      <ConfirmDialog
        open={pendingDeactivate !== null}
        onOpenChange={(open) => { if (!open) { setPendingDeactivate(null); setDeactivateError(null); } }}
        title="Deactivate item?"
        description={pendingDeactivate ? `"${pendingDeactivate.name}" will be marked inactive and hidden from new jobs. You can re-activate it later.` : ''}
        confirmLabel="Deactivate"
        confirmingLabel="Deactivating…"
        isConfirming={isConfirming}
        error={deactivateError}
        onConfirm={() => { void handleDeactivateConfirm(); }}
      />
    </PageShell>
  );
}
