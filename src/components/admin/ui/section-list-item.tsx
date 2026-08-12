import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface SectionListItemProps {
  readonly icon?: LucideIcon;
  readonly label: string;
  readonly value: React.ReactNode;
  /** Spans full width — use for addresses or multi-line values. */
  readonly wide?: boolean;
  readonly className?: string;
}

/**
 * A single label/value pair inside a SectionCard content area — a ruled
 * definition row: no box, no fill, just a hairline under each pair with an
 * 11 px/600 sentence-case label above a 13 px value.
 *
 * Uses semantic tokens only — no raw Tailwind palette classes.
 */
export function SectionListItem({
  icon: Icon,
  label,
  value,
  wide,
  className,
}: SectionListItemProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 border-b border-border py-2.5",
        wide && "sm:col-span-2",
        className,
      )}
    >
      {Icon && (
        <Icon
          className="mt-1 size-3.5 shrink-0 text-foreground-faint"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-semibold leading-[14px] tracking-[0.04em] text-muted-foreground">
          {label}
        </p>
        <div className="mt-1 text-[13px] leading-5 text-foreground">{value}</div>
      </div>
    </div>
  );
}
