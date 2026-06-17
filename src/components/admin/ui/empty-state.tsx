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
 * Standard empty/zero state: icon in a muted circle, bold title, muted
 * description, optional action. Covers first-run / no-results / filtered-out
 * by varying the copy + action passed in.
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
        "flex flex-col items-center justify-center gap-3 px-6 py-16 text-center",
        className,
      )}
    >
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-6" />
      </span>
      <div className="space-y-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
