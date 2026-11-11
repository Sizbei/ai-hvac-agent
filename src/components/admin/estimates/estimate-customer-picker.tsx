'use client';

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CustomerListRecord } from '@/lib/admin/crm-types';
import { customerNameLabel } from '@/lib/admin/customer-name-display';

const SEARCH_LIMIT = 5;

export interface PickedCustomer {
  readonly id: string;
  readonly name: string | null;
  readonly contact: string | null;
}

/** Debounced, org-scoped search (the customers API scopes by the session's org). */
function useCustomerSearch(query: string, enabled: boolean) {
  const [results, setResults] = useState<readonly CustomerListRecord[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const q = query.trim();
  const active = enabled && q.length >= 2;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      setIsSearching(true);
      setFailed(false);
      try {
        const res = await fetch(`/api/admin/customers?search=${encodeURIComponent(q)}`);
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && body?.success) {
          setResults((body.data.customers as CustomerListRecord[]).slice(0, SEARCH_LIMIT));
        } else {
          setFailed(true);
        }
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [q, active]);

  return { results: active ? results : [], isSearching: active && isSearching, failed, active };
}

/**
 * Required customer field for New estimate on the estimates list: an estimate
 * the customer can approve, and the invoice it becomes, both need one.
 */
export function EstimateCustomerPicker({
  value,
  onChange,
  error,
}: {
  readonly value: PickedCustomer | null;
  readonly onChange: (customer: PickedCustomer | null) => void;
  readonly error: string | null;
}) {
  const [searchInput, setSearchInput] = useState('');
  const search = useCustomerSearch(searchInput, value === null);
  const errorId = 'new-estimate-customer-error';

  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-2 text-sm font-medium">Customer</legend>
      {value ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{customerNameLabel(value.name)}</p>
            <p className="truncate text-xs text-muted-foreground">
              {value.contact ?? 'No contact on file'}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchInput('');
              onChange(null);
            }}
          >
            Change
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name, phone, email or address"
              aria-label="Search customers"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              className="pl-9"
            />
          </div>
          {search.active && (
            <div className="rounded-md border" aria-live="polite">
              {search.isSearching && search.results.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">Searching…</p>
              ) : search.failed ? (
                <p className="px-3 py-2 text-sm text-danger">
                  Couldn’t search customers. Please try again.
                </p>
              ) : search.results.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  No customers match “{searchInput.trim()}”.
                </p>
              ) : (
                <ul className="divide-y">
                  {search.results.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() =>
                          onChange({ id: c.id, name: c.name, contact: c.phone ?? c.email ?? null })
                        }
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                      >
                        <span className="truncate font-medium">{customerNameLabel(c.name)}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {c.phone ?? c.email ?? ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!search.active && (
            <p className="text-xs text-muted-foreground">
              Type at least 2 letters. To add a new customer, create them on the Customers page first.
            </p>
          )}
        </div>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
