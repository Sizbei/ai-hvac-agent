import { URGENCY_LEGEND, urgencyAccent } from "@/lib/admin/urgency-accent";
import { cn } from "@/lib/utils";

interface UrgencyLegendProps {
  readonly className?: string;
}

/**
 * Compact urgency colour key. Shared by the calendar and dispatch surfaces so
 * the dot colours read consistently with the urgency-accented cards/chips.
 *
 * Keys reuse `urgencyAccent().dot` to stay in lockstep with the calendar's
 * card accents (which are keyed off the same palette). Shape is a 6 px square,
 * not a dot — round markers are reserved for technician photos and switches.
 */
export function UrgencyLegend({ className }: UrgencyLegendProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] leading-[14px] text-muted-foreground",
        className,
      )}
    >
      <span className="font-semibold tracking-[0.04em]">Urgency:</span>
      {URGENCY_LEGEND.map(({ urgency, label }) => (
        <span key={urgency} className="flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-[1px]",
              urgencyAccent(urgency).dot,
            )}
          />
          {label}
        </span>
      ))}
    </div>
  );
}
