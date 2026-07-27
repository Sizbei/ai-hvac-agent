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
 * A single label/value row inside a SectionCard content area.
 * Replaces the repeated `rounded-lg border p-3` rows across the customer
 * detail page (contact info, equipment details, notes, follow-ups).
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
        "flex items-start gap-3 rounded-lg border bg-muted/20 px-3 py-2.5",
        wide && "sm:col-span-2",
        className,
      )}
    >
      {Icon && (
        <Icon
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <div className="mt-0.5 text-sm">{value}</div>
      </div>
    </div>
  );
}
