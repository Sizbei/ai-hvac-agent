'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Search, Loader2, Users, Receipt, ClipboardList, FileText, Tags, CornerDownLeft } from 'lucide-react';
import {
  Dialog,
  DialogContent,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { SearchResult } from '@/lib/admin/search-queries';
import { SyncPill } from '@/components/admin/sync-pill';
import { NAV_GROUPS } from '@/components/admin/nav-items';
import { filterCommands, type CommandItem } from '@/lib/admin/nav-search';

/** Every admin destination, flattened — the ⌘K search matches these as "Pages". */
const NAV_ITEMS: CommandItem[] = NAV_GROUPS.flatMap((g) =>
  g.items.map((it) => ({ label: it.label, href: it.href, group: g.heading })),
);

const TYPE_LABELS: Record<SearchResult['type'], string> = {
  customer: 'Customers',
  invoice: 'Invoices',
  job: 'Jobs',
  estimate: 'Estimates',
  pricebook: 'Pricebook',
};

const TYPE_ORDER: SearchResult['type'][] = ['customer', 'invoice', 'job', 'estimate', 'pricebook'];

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
    case 'pricebook':
      return <Tags className={cls} />;
  }
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

  // Page-navigation matches (instant, client-side) come first, then record
  // results from the API. Both share one keyboard-navigable index.
  // When the query is empty, show up to 8 nav items as "Quick navigation".
  const isEmptyQuery = !query.trim();
  const navItems = isEmptyQuery ? NAV_ITEMS.slice(0, 8) : filterCommands(query, NAV_ITEMS);
  const navCount = navItems.length;
  const grouped = groupResults(results);
  const recordFlat = grouped.flatMap((g) => g.items);
  const totalCount = navCount + recordFlat.length;

  function navigateTo(href: string) {
    router.push(href);
    closeAndReset();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, totalCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (activeIndex < navCount) {
        const p = navItems[activeIndex];
        if (p) navigateTo(p.href);
      } else {
        const r = recordFlat[activeIndex - navCount];
        if (r) navigateTo(r.href);
      }
    } else if (e.key === 'Escape') {
      closeAndReset();
    }
  }

  // Record global indices sit AFTER the page items (offset by navCount).
  const recordIndexMap = new Map(recordFlat.map((item, i) => [item.id, i]));

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
            placeholder="Search pages, customers, invoices, jobs…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {loading && (
            <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
          )}
        </div>

        {/* Results */}
        <div className="max-h-[360px] overflow-y-auto py-2">
          {/* Pages / Quick navigation — instant client-side navigation matches */}
          {navItems.length > 0 && (
            <div>
              <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {isEmptyQuery ? 'Quick navigation' : 'Pages'}
              </p>
              {navItems.map((item, i) => {
                const isActive = i === activeIndex;
                return (
                  <button
                    key={item.href}
                    type="button"
                    onClick={() => navigateTo(item.href)}
                    onMouseEnter={() => setActiveIndex(i)}
                    className={cn(
                      'flex w-full items-center gap-3 px-4 py-2 text-left text-sm',
                      'transition-colors duration-150 ease-[cubic-bezier(.23,1,.32,1)] motion-reduce:transition-none',
                      isActive ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    )}
                  >
                    <CornerDownLeft className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate font-medium">{item.label}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{item.group}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Record placeholders — suppressed when nav items fill the list */}
          {navCount === 0 && !loading && query.length >= 2 && results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No results for &ldquo;{query}&rdquo;
            </p>
          )}

          {grouped.map((group) => (
            <div key={group.type}>
              <p className="px-4 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                {TYPE_LABELS[group.type]}
              </p>
              {group.items.map((item) => {
                const currentIdx = navCount + (recordIndexMap.get(item.id) ?? 0);
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
                      <SyncPill
                        source={item.syncedSource === 'hcp' ? 'housecall' : item.syncedSource}
                        size="sm"
                      />
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
