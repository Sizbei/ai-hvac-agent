import { cn } from "@/lib/utils";

interface SectionDividerProps {
  /** Optional label rendered at the start of the rule. */
  readonly label?: string;
  readonly className?: string;
}

/**
 * Horizontal rule divider for separating logical sections within a page or
 * card. When `label` is provided, the text sits left-aligned on the rule.
 *
 * Used in staff page between the active staff table and pending invites.
 */
export function SectionDivider({ label, className }: SectionDividerProps) {
  if (!label) {
    return <hr className={cn("border-border", className)} />;
  }

  return (
    <div className={cn("flex items-center gap-3", className)}>
      <hr className="flex-1 border-border" />
      <span className="text-xs text-muted-foreground">{label}</span>
      <hr className="flex-1 border-border" />
    </div>
  );
}
