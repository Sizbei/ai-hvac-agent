/**
 * Shared skeleton components for heavy admin pages.
 * Display-only — no logic, no state, no props beyond optional className.
 * Bars are sunken slabs that breathe (opacity 0.9 ↔ 0.55) — the single loading
 * animation in the system. No shimmer, no pulse; prefers-reduced-motion is
 * handled globally by the animation clamp in globals.css.
 */

import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

// ── primitives ────────────────────────────────────────────────────────────────

function Bar({ className }: { className?: string }) {
  return <Skeleton aria-hidden="true" className={cn('rounded-[3px]', className)} />;
}

// ── TableSkeleton ─────────────────────────────────────────────────────────────

interface TableSkeletonProps {
  /** Number of skeleton rows to render. Defaults to 6. */
  rows?: number;
  /** Number of columns. Defaults to 5. */
  cols?: number;
}

/**
 * Breathing table-like rows that match a list-grid layout.
 * Wrap in the same container your real table lives in.
 */
export function TableSkeleton({ rows = 6, cols = 5 }: TableSkeletonProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border-strong bg-surface">
      {/* sunken header band */}
      <div className="border-b border-border-strong bg-surface-sunken px-4 py-2.5">
        <Bar className="h-3 w-64" />
      </div>
      {/* rows */}
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-0"
        >
          {Array.from({ length: cols }, (__, j) => (
            <Bar
              key={j}
              className={cn(
                'h-3.5',
                j === 0 ? 'w-24 shrink-0' : 'flex-1',
                j === cols - 1 && 'max-w-[120px]',
              )}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── StatTileSkeleton ──────────────────────────────────────────────────────────

/**
 * Placeholder for a KPI stat tile (number + label).
 */
export function StatTileSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border-strong bg-surface px-4 py-3">
      <Bar className="h-3 w-24" />
      <Bar className="h-[26px] w-28" />
      <Bar className="h-3 w-16" />
    </div>
  );
}

// ── CardSkeleton ──────────────────────────────────────────────────────────────

/**
 * Placeholder for a card-style list row (e.g. customer cards).
 */
export function CardSkeleton() {
  return (
    <div className="flex items-center gap-4 rounded-lg border border-border-strong bg-surface p-4">
      {/* square avatar slab */}
      <Bar className="size-10 shrink-0 rounded-[4px]" />
      <div className="flex flex-1 flex-col gap-2">
        <Bar className="h-3.5 w-40" />
        <Bar className="h-3 w-56" />
      </div>
      <div className="flex gap-3">
        <Bar className="h-3 w-12" />
        <Bar className="h-3 w-12" />
      </div>
    </div>
  );
}
