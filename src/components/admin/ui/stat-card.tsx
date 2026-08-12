import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { type IconChipIntent } from "@/components/admin/ui/icon-chip";
import { cn } from "@/lib/utils";

export type { IconChipIntent as StatCardIntent };

interface StatCardProps {
  /** Sentence-case label, e.g. "Pending requests". */
  readonly label: string;
  /** The primary metric value — rendered in tabular mono. */
  readonly value: string | number;
  /** Optional icon, pinned 14 px top-right in `--foreground-faint`. */
  readonly icon?: LucideIcon;
  /**
   * Retained for API compatibility. The KPI cell no longer tints: the redesign
   * spec bans tinted icon chips inside KPI cells (the number is the signal).
   */
  readonly intent?: IconChipIntent;
  /** Optional muted sub-label beneath the value (e.g. "vs prev period"). */
  readonly sublabel?: string;
  /**
   * Period-over-period delta. Positive = up, negative = down.
   * Pass `{ value: string, good: boolean }` for explicit sentiment control,
   * or a raw number for automatic sign-based sentiment (positive = good).
   */
  readonly delta?: { readonly value: string; readonly good: boolean } | number;
  /** "sm" is compact (sidebar widgets), "lg" is the default dashboard tile. */
  readonly size?: "sm" | "lg";
  /** Show loading skeleton instead of value. */
  readonly loading?: boolean;
  readonly className?: string;
}

/** Resolve a raw-number delta into the display shape. */
function resolveDelta(
  delta: StatCardProps["delta"],
): { value: string; good: boolean } | null {
  if (delta === undefined || delta === null) return null;
  if (typeof delta === "number") {
    // A zero delta is "no change" — render nothing rather than "improved by 0".
    if (delta === 0) return null;
    return { value: `${delta > 0 ? "+" : ""}${delta}`, good: delta > 0 };
  }
  return delta;
}

/**
 * KPI cell — the single stat tile for every admin surface (dashboard, reports,
 * operations, insights, estimates, reviews, invoices).
 *
 * Shop-floor instrument treatment: flat bordered panel, sentence-case 11 px
 * label, 26 px tabular-mono value, bare ▲/▼ delta line, and a 14 px faint icon
 * pinned top-right. No tinted chips, no pills, no shadow.
 *
 * Wrap several in `<StatStrip>` to fuse them into one container with internal
 * hairlines (the cell renders borderless and square inside a strip).
 */
export function StatCard({
  label,
  value,
  icon: Icon,
  sublabel,
  delta,
  size = "lg",
  loading = false,
  className,
}: StatCardProps) {
  const resolvedDelta = resolveDelta(delta);

  return (
    <div
      data-slot="stat-card"
      className={cn(
        "relative flex flex-col rounded-lg border border-border-strong bg-surface",
        size === "lg" ? "px-4 py-3" : "px-3 py-2.5",
        className,
      )}
    >
      {Icon && (
        <Icon
          aria-hidden="true"
          className="absolute right-3 top-3 size-3.5 text-foreground-faint"
        />
      )}

      <p className="pr-6 text-[11px] font-semibold leading-[14px] tracking-[0.04em] text-muted-foreground">
        {label}
      </p>

      {loading ? (
        <Skeleton
          className={cn("mt-2", size === "lg" ? "h-[26px] w-24" : "h-5 w-16")}
        />
      ) : (
        <p
          className={cn(
            "mt-1.5 font-mono font-medium leading-none tabular-nums text-foreground",
            size === "lg" ? "text-[26px]" : "text-[20px]",
          )}
        >
          {value}
        </p>
      )}

      {!loading && sublabel && (
        <p className="mt-1.5 text-[11px] leading-[14px] text-muted-foreground">
          {sublabel}
        </p>
      )}

      {!loading && resolvedDelta && <DeltaLine delta={resolvedDelta} />}
    </div>
  );
}

/**
 * Fused KPI strip — one container, internal hairlines, zero gap.
 *
 * Children (typically `<StatCard>`) render borderless and square inside; the
 * strip owns the outer border and draws the dividers as inset shadows so a
 * child's own border utilities can't double up.
 */
export function StatStrip({
  children,
  className,
}: {
  readonly children: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="stat-strip"
      className={cn(
        "grid grid-flow-row overflow-hidden rounded-lg border border-border-strong bg-surface sm:auto-cols-fr sm:grid-flow-col",
        // children go borderless + square; dividers are drawn by the strip
        "[&>*]:rounded-none [&>*]:border-0 [&>*]:bg-transparent",
        "[&>*+*]:shadow-[inset_0_1px_0_var(--border)] sm:[&>*+*]:shadow-[inset_1px_0_0_var(--border)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

function DeltaLine({
  delta,
}: {
  readonly delta: { value: string; good: boolean };
}) {
  return (
    <p className="mt-1.5 font-mono text-[11px] leading-[14px] tabular-nums">
      <span className="sr-only">
        {delta.good ? "Improved" : "Declined"} by {delta.value}
      </span>
      <span
        aria-hidden="true"
        className={
          delta.good ? "text-success-strong" : "text-danger-strong"
        }
      >
        {delta.good ? "▲" : "▼"} {delta.value}
      </span>
    </p>
  );
}
