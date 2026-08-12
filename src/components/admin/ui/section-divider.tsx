import { cn } from "@/lib/utils";

interface SectionDividerProps {
  /** Optional label rendered at the start of the rule. */
  readonly label?: string;
  readonly className?: string;
}

/**
 * Hairline divider for separating logical sections within a page or panel.
 * When `label` is provided, the micro label sits at the start of the rule
 * (sentence case, 11 px/600 — the uppercase `.u-label` treatment is reserved
 * for sidebar groups and status chips).
 *
 * Used in staff page between the active staff table and pending invites.
 */
export function SectionDivider({ label, className }: SectionDividerProps) {
  if (!label) {
    return <hr className={cn("border-t border-border", className)} />;
  }

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <span className="shrink-0 text-[11px] font-semibold leading-[14px] tracking-[0.04em] text-muted-foreground">
        {label}
      </span>
      <hr className="flex-1 border-t border-border" />
    </div>
  );
}
