/**
 * Shared skeleton components for heavy admin pages.
 * Display-only — no logic, no state, no props beyond optional className.
 * Uses theme tokens (bg-muted) and animate-pulse; respects prefers-reduced-motion
 * via the motion-reduce:animate-none Tailwind variant.
 */

import { cn } from '@/lib/utils';

// ── primitives ────────────────────────────────────────────────────────────────

function Bar({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-md bg-muted motion-reduce:animate-none',
        className,
      )}
    />
  );
}

// ── TableSkeleton ─────────────────────────────────────────────────────────────

interface TableSkeletonProps {
  /** Number of skeleton rows to render. Defaults to 6. */
  rows?: number;
  /** Number of columns. Defaults to 5. */
  cols?: number;
}

/**
 * Shimmering table-like rows that match a list-grid layout.
 * Wrap in the same container your real table lives in.
 */
export function TableSkeleton({ rows = 6, cols = 5 }: TableSkeletonProps) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      {/* header bar */}
      <div className="border-b bg-muted/40 px-4 py-3">
        <Bar className="h-3 w-64" />
      </div>
      {/* rows */}
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0"
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
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm">
      <Bar className="h-3 w-24" />
      <Bar className="h-9 w-28" />
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
    <div className="flex items-center gap-4 rounded-xl border bg-card p-4 shadow-sm">
      {/* avatar circle */}
      <Bar className="size-10 shrink-0 rounded-full" />
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
