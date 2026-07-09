'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Loader2, Users, Receipt, ClipboardList, FileText } from 'lucide-react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { SearchResult } from '@/lib/admin/search-queries';

const TYPE_LABELS: Record<SearchResult['type'], string> = {
  customer: 'Customers',
  invoice: 'Invoices',
  job: 'Jobs',
  estimate: 'Estimates',
};

const TYPE_ORDER: SearchResult['type'][] = ['customer', 'invoice', 'job', 'estimate'];

function TypeIcon({ type }: { type: SearchResult['type'] }) {
  const cls = 'size-4 shrink-0 text-muted-foreground';
  switch (type) {
    case 'customer':
      return <Users className={cls} />;
    case 'invoice':
      return <Receipt className={cls} />;
    case 'job':
      return <ClipboardList className={cls} />;
    case 'estimate':
      return <FileText className={cls} />;
  }
}

function SyncPill({ source }: { source: 'fieldpulse' | 'hcp' }) {
  return (
    <span className="ml-auto shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {source === 'fieldpulse' ? 'FP' : 'HCP'}
    </span>
  );
}

/** Groups results by type in the canonical order. */
function groupResults(
  results: SearchResult[],
): Array<{ type: SearchResult['type']; items: SearchResult[] }> {
  const map = new Map<SearchResult['type'], SearchResult[]>();
  for (const r of results) {
    map.set(r.type, [...(map.get(r.type) ?? []), r]);
  }
  return TYPE_ORDER.filter((t) => map.has(t)).map((t) => ({
    type: t,
    items: map.get(t)!,
  }));
}

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const router = useRouter();

  function closeAndReset() {
    setOpen(false);
    setQuery('');
    setResults([]);
    setActiveIndex(0);
  }

  // ⌘K / Ctrl-K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Custom event from the sidebar search button
  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener('global-search:open', handler);
    return () => window.removeEventListener('global-search:open', handler);
  }, []);

  // Debounced fetch on query change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (query.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear stale results when q drops below minimum
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    // Abort in-flight fetches when the query changes so a slow stale response
    // can never overwrite newer results.
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/admin/search?q=${encodeURIComponent(query)}`,
          { signal: controller.signal },
        );
        if (res.ok) {
          const json = (await res.json()) as { data?: { results?: SearchResult[] } };
          setResults(json.data?.results ?? []);
        }
        setLoading(false);
        setActiveIndex(0);
      } catch (e) {
        // Aborted = superseded by a newer query, which now owns the loading
        // state — exit without touching it. Other failures are non-fatal.
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setLoading(false);
      }
    }, 300);

    debounceRef.current = timer;

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const grouped = groupResults(results);
  const flat = grouped.flatMap((g) => g.items);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && flat[activeIndex]) {
      router.push(flat[activeIndex].href);
      closeAndReset();
    } else if (e.key === 'Escape') {
      closeAndReset();
    }
  }

  // Pre-compute flat indices so render stays pure (no mutable counter).
  const flatIndexMap = new Map(flat.map((item, i) => [item.id, i]));

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeAndReset();
        else setOpen(true);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-xl overflow-hidden p-0"
      >
        {/* Search input row */}
        <div className="flex items-center gap-3 border-b px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            maxLength={100}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Search customers, invoices, jobs, estimates…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {loading && (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* Results */}
        <div className="max-h-[360px] overflow-y-auto py-2">
          {!loading && query.length >= 2 && results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No results for &ldquo;{query}&rdquo;
            </p>
          )}
          {query.length < 2 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              Type at least 2 characters to search
            </p>
          )}

          {grouped.map((group) => (
            <div key={group.type}>
              <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {TYPE_LABELS[group.type]}
              </p>
              {group.items.map((item) => {
                const currentIdx = flatIndexMap.get(item.id) ?? 0;
                const isActive = currentIdx === activeIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      router.push(item.href);
                      closeAndReset();
                    }}
                    onMouseEnter={() => setActiveIndex(currentIdx)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2 text-left text-sm',
                      'transition-colors duration-150 ease-[cubic-bezier(.23,1,.32,1)] motion-reduce:transition-none',
                      isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    )}
                  >
                    <TypeIcon type={item.type} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{item.title}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {item.subtitle}
                      </span>
                    </span>
                    {item.syncedSource && (
                      <SyncPill source={item.syncedSource} />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
