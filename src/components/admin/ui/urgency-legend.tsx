import { URGENCY_LEGEND, urgencyAccent } from "@/lib/admin/urgency-accent";
import { cn } from "@/lib/utils";

interface UrgencyLegendProps {
  readonly className?: string;
}

/**
 * Compact urgency colour key. Shared by the calendar and dispatch surfaces so
 * the dot colours read consistently with the urgency-accented cards/chips.
 *
 * Dots reuse `urgencyAccent().dot` to stay in lockstep with the calendar's
 * card accents (which are keyed off the same palette).
 */
export function UrgencyLegend({ className }: UrgencyLegendProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
    >
      <span className="font-medium">Urgency:</span>
      {URGENCY_LEGEND.map(({ urgency, label }) => (
        <span key={urgency} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn("size-2.5 rounded-full", urgencyAccent(urgency).dot)}
          />
          {label}
        </span>
      ))}
    </div>
  );
}
