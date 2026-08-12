'use client';

import { Fragment, useCallback, useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Plus, AlertCircle, AlertTriangle, FileText, FolderOpen, Clock, Trophy, Gauge, Search } from 'lucide-react';
import { useEstimates, type EstimatePipelineStats } from '@/hooks/use-estimates';
import { useUrlFilterSync } from '@/hooks/use-url-filter-sync';
import { EstimateCreateDialog } from '@/components/admin/estimates/estimate-create-dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { TableSkeleton } from '@/components/admin/skeletons';
import { formatCentsExact } from '@/lib/admin/money-format';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { StatCard, StatStrip } from '@/components/admin/ui/stat-card';
import { EmptyState } from '@/components/admin/ui/empty-state';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Pager } from '@/components/admin/ui/pager';
import {
  FPS_STATUS_BADGE,
  FPS_STATUS_DEFAULT,
  ESTIMATE_STATUS_BADGE,
  ESTIMATE_STATUS_DEFAULT,
} from '@/lib/admin/status-colors';
import { SyncPill } from '@/components/admin/sync-pill';
import { FieldpulseDetails } from '@/components/admin/fieldpulse-details';
import { cn } from '@/lib/utils';

// ── constants ──────────────────────────────────────────────────────────────────

const PER_PAGE = 50;
type Bucket = 'open' | 'won' | 'lost' | 'draft';

// ── local FPS status pill ──────────────────────────────────────────────────────
// EstimateStatusBadge renders native enum values only; fps names (Sent, Estimate,
// Accepted, Completed, Lost, Draft) need a local pill. Both draw from the shared
// token status maps so colour goes through semantic tokens only.

const NATIVE_LABELS: Record<string, string> = {
  open: 'Open',
  sold: 'Sold',
  dismissed: 'Dismissed',
  expired: 'Expired',
};

function StatusPill({ fps, native }: { fps: string | null; native: string }) {
  if (fps) {
    const cls = FPS_STATUS_BADGE[fps] ?? FPS_STATUS_DEFAULT;
    return (
      <Badge variant="outline" className={cls}>
        {fps}
      </Badge>
    );
  }
  const cls = ESTIMATE_STATUS_BADGE[native] ?? ESTIMATE_STATUS_DEFAULT;
  return (
    <Badge variant="outline" className={cls}>
      {NATIVE_LABELS[native] ?? native}
    </Badge>
  );
}

// ── helpers ────────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

function ageDays(effectiveCreatedAt: string): number {
  return Math.floor((Date.now() - new Date(effectiveCreatedAt).getTime()) / 86_400_000);
}

/** Mirrors the server's BUCKET_CASE_SQL open semantics: open = NOT won/lost/
 * draft (the ELSE arm), so custom FP status names land in open here too — an
 * allowlist would drop the ⚠/follow-up affordances for rows the Open tab and
 * staleCount already include. */
function isOpenEstimate(fps: string | null, native: string): boolean {
  if (fps) {
    const s = fps.toLowerCase();
    return !['accepted', 'completed', 'lost', 'draft'].includes(s);
  }
  return native === 'open';
}

// ── KPI band ──────────────────────────────────────────────────────────────────

function KpiBand({ stats }: { stats: EstimatePipelineStats | null }) {
  const s = stats;
  return (
    <StatStrip>
      <StatCard
        icon={FolderOpen}
        intent="info"
        label="Open pipeline"
        value={formatCentsExact(s?.openCents ?? 0)}
        sublabel={`${s?.openCount ?? 0} open estimates`}
      />
      <StatCard
        icon={Clock}
        intent="warning"
        label="Needs follow-up"
        value={formatCentsExact(s?.staleCents ?? 0)}
        sublabel={`${s?.staleCount ?? 0} open >14 days`}
      />
      <StatCard
        icon={Trophy}
        intent="success"
        label="Won"
        value={formatCentsExact(s?.wonCents ?? 0)}
        sublabel={
          s?.winRatePct != null
            ? `${s?.wonCount ?? 0} won · win rate ${s.winRatePct}%`
            : `${s?.wonCount ?? 0} won`
        }
      />
      <StatCard
        icon={Gauge}
        intent="neutral"
        label="Avg age of open"
        value={`${s?.avgOpenAgeDays ?? 0}d`}
        sublabel={`${s?.lostCount ?? 0} lost (${formatCentsExact(s?.lostCents ?? 0)})`}
      />
    </StatStrip>
  );
}

// ── tab config ────────────────────────────────────────────────────────────────

interface TabDef {
  value: Bucket | null; // null = All
  label: string;
}

const TABS: ReadonlyArray<TabDef> = [
  { value: 'open',  label: 'Open' },
  { value: 'won',   label: 'Won' },
  { value: 'lost',  label: 'Lost' },
  { value: 'draft', label: 'Draft' },
  { value: null,    label: 'All' },
];

function tabCount(stats: EstimatePipelineStats | null, bucket: Bucket | null): number {
  if (!stats) return 0;
  if (bucket === null) return stats.openCount + stats.wonCount + stats.lostCount + stats.draftCount;
  return stats[`${bucket}Count`];
}

function tabCents(stats: EstimatePipelineStats | null, bucket: Bucket | null): number {
  if (!stats) return 0;
  if (bucket === null) return stats.openCents + stats.wonCents + stats.lostCents + stats.draftCents;
  return stats[`${bucket}Cents`];
}

function emptyMessage(bucket: Bucket | null): string {
  if (bucket === 'open')  return 'No open estimates — the pipeline is clear.';
  if (bucket === 'won')   return 'No won estimates yet.';
  if (bucket === 'lost')  return 'No lost estimates.';
  if (bucket === 'draft') return 'No draft estimates.';
  return 'No estimates yet. Create one to send a customer a proposal.';
}

// ── page ──────────────────────────────────────────────────────────────────────

export default function EstimatesPage() {
  useEffect(() => { document.title = 'Estimates · Spears Admin'; }, []);
  const searchRef = useRef<HTMLInputElement>(null);
  // Default to Open — the actionable tab (the follow-up list), per the
  // approved mockup; All is one click away.
  const [activeBucket, setActiveBucket] = useState<Bucket | null>('open');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Persist filters to the URL (shareable links + survives refresh). Page is
  // intentionally NOT persisted. Default 'open' maps to '' (dropped from URL);
  // null (All) serialises as 'all'.
  function bucketToParam(b: Bucket | null): string {
    if (b === 'open') return '';
    if (b === null) return 'all';
    return b;
  }
  const urlFilterState = {
    bucket: bucketToParam(activeBucket),
    q: search,
  };
  const restoreFiltersFromUrl = useCallback((p: Record<string, string>) => {
    const buckets: readonly string[] = ['open', 'won', 'lost', 'draft'];
    if (p.bucket) {
      if (buckets.includes(p.bucket)) setActiveBucket(p.bucket as Bucket);
      else if (p.bucket === 'all') setActiveBucket(null);
    }
    if (p.q) { setSearch(p.q); setDebouncedSearch(p.q); }
  }, []);
  useUrlFilterSync(urlFilterState, restoreFiltersFromUrl);

  // Debounce the search box so browsing fires one request per pause, not per key.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever search changes.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

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

  const { estimates, total, stats, isLoading, error, refetch } = useEstimates({
    page,
    bucket: activeBucket ?? undefined,
    search: debouncedSearch || undefined,
  });

  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const safePage = Math.min(page, totalPages);

  function switchTab(bucket: Bucket | null) {
    setActiveBucket(bucket);
    setPage(1);
    setExpandedId(null);
  }

  return (
    <PageShell>
      <PageHeader
        title="Estimates"
        subtitle="Sales pipeline — proposals, follow-ups, and win tracking."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New estimate
          </Button>
        }
      />

      {/* KPI band */}
      {isLoading
        ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
          </div>
        )
        : <KpiBand stats={stats} />
      }

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Search + status tabs toolbar */}
      <div className="relative sm:max-w-sm">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          aria-label="Search estimates"
          placeholder="Search by customer name or title..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Status tabs */}
      <div className="overflow-x-auto">
        <SegmentedControl<string>
          aria-label="Filter estimates by status"
          options={TABS.map((tab) => ({
            value: tab.value ?? 'all',
            label: stats
              ? `${tab.label} · ${formatCentsExact(tabCents(stats, tab.value))}`
              : tab.label,
            badge: stats ? tabCount(stats, tab.value) : undefined,
          }))}
          value={activeBucket ?? 'all'}
          onChange={(v) => switchTab(v === 'all' ? null : (v as Bucket))}
        />
      </div>

      {/* List */}
      {isLoading ? (
        <TableSkeleton rows={8} cols={6} />
      ) : estimates.length === 0 ? (
        <Card className="p-5">
          <EmptyState
            icon={FileText}
            title="No estimates"
            description={emptyMessage(activeBucket)}
          />
        </Card>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-[11px] font-medium text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Customer</th>
                <th scope="col" className="px-4 py-2 font-medium max-w-48">Title</th>
                <th scope="col" className="px-4 py-2 font-medium text-right">Total</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="px-4 py-2 font-medium">Waiting</th>
                <th scope="col" className="px-4 py-2 w-8" />
              </tr>
            </thead>
            <tbody>
              {estimates.map((est) => {
                const isExpanded = expandedId === est.id;
                const age = ageDays(est.effectiveCreatedAt);
                // Flag stale on Open tab or All tab (when this specific row is open).
                const stale = age > 14 && isOpenEstimate(est.fieldpulseStatusName, est.status);
                const toggle = () => setExpandedId((prev) => (prev === est.id ? null : est.id));

                return (
                  // Key on the Fragment — it is the array element.
                  <Fragment key={est.id}>
                    <tr className="border-t hover:bg-muted/30 cursor-pointer">
                      {/* Customer (bold) + SyncPill */}
                      <td className="px-4 py-3" onClick={toggle}>
                        <div className="flex flex-col items-start gap-0.5">
                          <span className="font-semibold">
                            {est.customerName ?? (est.customerId ? 'Customer' : '—')}
                          </span>
                          {est.syncedSource === 'fieldpulse' && (
                            <SyncPill source={est.syncedSource} size="md" />
                          )}
                        </div>
                      </td>
                      {/* Estimate title (muted, truncate) */}
                      <td className="px-4 py-3 max-w-48" onClick={toggle}>
                        {est.title
                          ? <span className="block truncate text-muted-foreground">{est.title}</span>
                          : <span className="text-muted-foreground/50 italic text-xs">no title</span>
                        }
                      </td>
                      {/* Total (right, formatCentsExact) */}
                      <td className="px-4 py-3 text-right font-medium tabular-nums" onClick={toggle}>
                        {formatCentsExact(est.totalCents)}
                      </td>
                      {/* Status pill */}
                      <td className="px-4 py-3" onClick={toggle}>
                        <StatusPill fps={est.fieldpulseStatusName} native={est.status} />
                      </td>
                      {/* Waiting: Nd, amber+⚠ when open >14d */}
                      <td className="px-4 py-3" onClick={toggle}>
                        <span className={cn(
                          'inline-flex items-center gap-0.5 text-xs tabular-nums',
                          stale ? 'text-warning font-medium' : 'text-muted-foreground',
                        )}>
                          {stale && <AlertTriangle aria-hidden="true" className="size-3.5" />}
                          {age}d
                        </span>
                      </td>
                      {/* Chevron with aria-expanded */}
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          aria-expanded={isExpanded}
                          aria-label={isExpanded ? 'Collapse row' : 'Expand row'}
                          onClick={toggle}
                          className="ml-auto flex items-center justify-center rounded text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {isExpanded
                            ? <ChevronDown className="size-4" />
                            : <ChevronRight className="size-4" />
                          }
                        </button>
                      </td>
                    </tr>

                    {isExpanded && (
                      /* No border-t: panel reads as one unit with its row */
                      <tr key={`${est.id}-expand`}>
                        <td colSpan={6} className="bg-muted/30 px-6 py-4 animate-in fade-in-0 slide-in-from-top-1 duration-100 motion-reduce:animate-none">
                          <div className="flex flex-wrap gap-6">
                            {/* Key facts */}
                            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                              {est.title && (
                                <>
                                  <dt className="text-muted-foreground">Title</dt>
                                  <dd>{est.title}</dd>
                                </>
                              )}
                              <dt className="text-muted-foreground">Status</dt>
                              <dd>
                                <StatusPill fps={est.fieldpulseStatusName} native={est.status} />
                              </dd>
                              <dt className="text-muted-foreground">Total</dt>
                              <dd className="font-medium tabular-nums">{formatCentsExact(est.totalCents)}</dd>
                              <dt className="text-muted-foreground">Created</dt>
                              <dd className="tabular-nums">{formatDate(est.effectiveCreatedAt)}</dd>
                              {est.expiresAt && (
                                <>
                                  <dt className="text-muted-foreground">Expires</dt>
                                  <dd className="tabular-nums">{formatDate(est.expiresAt)}</dd>
                                </>
                              )}
                              {est.signedAt && (
                                <>
                                  <dt className="text-muted-foreground">Signed</dt>
                                  <dd className="tabular-nums">{formatDate(est.signedAt)}</dd>
                                </>
                              )}
                            </dl>

                            {/* FieldPulse details */}
                            {est.fieldpulseData && (
                              <div className="flex-1 min-w-48">
                                <FieldpulseDetails data={est.fieldpulseData} />
                              </div>
                            )}
                          </div>

                          {/* Actions */}
                          <div className="mt-4 flex flex-wrap gap-2" onClick={(e) => e.stopPropagation()}>
                            <Link href={`/admin/estimates/${est.id}`}>
                              <Button variant="outline" size="sm">
                                View estimate →
                              </Button>
                            </Link>

                            {/* Log follow-up: open estimates only.
                                Link to customer's follow-up section when present;
                                request page as fallback. No new backend — YAGNI. */}
                            {isOpenEstimate(est.fieldpulseStatusName, est.status) && (
                              <Link
                                href={
                                  est.customerId
                                    ? `/admin/customers/${est.customerId}#follow-ups`
                                    : est.serviceRequestId
                                    ? `/admin/requests?request=${est.serviceRequestId}`
                                    : `/admin/estimates/${est.id}`
                                }
                              >
                                <Button variant="ghost" size="sm">
                                  Log follow-up
                                </Button>
                              </Link>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pager — only shown when there are results */}
      {total > 0 && (
        <Pager
          page={safePage}
          totalPages={totalPages}
          total={total}
          perPage={PER_PAGE}
          onPageChange={setPage}
          showFirstLast
        />
      )}

      <EstimateCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setPage(1);
          void refetch();
        }}
      />
    </PageShell>
  );
}
