import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface EmptyStateProps {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
  /** Optional primary action (e.g. a Button). Per the design checklist,
   * prefer a real next step over "refresh". */
  readonly action?: React.ReactNode;
  readonly className?: string;
}

/**
 * Standard empty/zero state: 20 px glyph in a 40 px sunken square, 15 px
 * headline, 13 px muted line, optional action. Covers first-run / no-results /
 * filtered-out by varying the copy + action passed in.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-md bg-surface-sunken text-foreground-faint">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <p className="text-[15px] font-medium leading-5 text-foreground">
          {title}
        </p>
        <p className="max-w-sm text-[13px] leading-5 text-muted-foreground">
          {description}
        </p>
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
