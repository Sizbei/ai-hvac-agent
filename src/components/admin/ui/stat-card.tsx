import type { LucideIcon } from "lucide-react";
import { ArrowUp, ArrowDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { IconChip, type IconChipIntent } from "@/components/admin/ui/icon-chip";
import { cn } from "@/lib/utils";

export type { IconChipIntent as StatCardIntent };

interface StatCardProps {
  /** Sentence-case label, e.g. "Pending requests". */
  readonly label: string;
  /** The primary metric value, displayed at 2× body scale. */
  readonly value: string | number;
  /** Optional icon, rendered through IconChip. */
  readonly icon?: LucideIcon;
  /** Intent drives the IconChip tint. Defaults to "neutral". */
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
    // A zero delta is "no change" — render no pill rather than "improved by 0".
    if (delta === 0) return null;
    return { value: `${delta > 0 ? "+" : ""}${delta}`, good: delta > 0 };
  }
  return delta;
}

/**
 * Unified stat / KPI tile — replaces the six diverging implementations:
 * stats-cards.tsx, dashboard-stat-cards.tsx, reports KpiCard, operations
 * KpiCard, insights inline cards, ops-insights-section StatCard.
 *
 * Value renders at 2× body scale with `font-heading` + `tabular-nums`.
 * Icon is threaded through `IconChip` using semantic tokens only.
 * Skeleton matches the loaded shape.
 */
export function StatCard({
  label,
  value,
  icon,
  intent = "neutral",
  sublabel,
  delta,
  size = "lg",
  loading = false,
  className,
}: StatCardProps) {
  const resolvedDelta = resolveDelta(delta);

  return (
    <Card
      className={cn(
        "flex flex-col gap-0",
        size === "lg" ? "p-5" : "p-4",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {icon && (
          <IconChip icon={icon} intent={intent} size={size === "lg" ? "md" : "sm"} />
        )}
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "text-muted-foreground",
              size === "lg" ? "text-sm" : "text-xs",
            )}
          >
            {label}
          </p>

          {loading ? (
            <Skeleton
              className={cn("mt-1", size === "lg" ? "h-9 w-24" : "h-7 w-16")}
            />
          ) : (
            <p
              className={cn(
                "mt-0.5 font-heading font-bold leading-none tabular-nums tracking-tight",
                size === "lg" ? "text-3xl" : "text-2xl",
              )}
            >
              {value}
            </p>
          )}

          {!loading && sublabel && (
            <p className="mt-0.5 text-xs text-muted-foreground">{sublabel}</p>
          )}

          {!loading && resolvedDelta && (
            <DeltaPill delta={resolvedDelta} />
          )}
        </div>
      </div>
    </Card>
  );
}

function DeltaPill({
  delta,
}: {
  readonly delta: { value: string; good: boolean };
}) {
  const Arrow = delta.good ? ArrowUp : ArrowDown;
  return (
    <div className="mt-1.5 flex items-center gap-1">
      <span className="sr-only">
        {delta.good ? "Improved" : "Declined"} by {delta.value}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs font-semibold",
          delta.good
            ? "bg-success-light text-success-strong"
            : "bg-danger-light text-danger-strong",
        )}
      >
        <Arrow className="size-3" />
        {delta.value}
      </span>
    </div>
  );
}
