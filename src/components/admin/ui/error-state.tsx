import type { LucideIcon } from "lucide-react";
import { AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface ErrorStateProps {
  /** Bold error title, e.g. "Invoice not found". */
  readonly title: string;
  /** Optional muted descriptor below the title. */
  readonly description?: string;
  /** Optional icon in a muted circle. Defaults to `AlertCircle`. */
  readonly icon?: LucideIcon;
  /** Optional action (typically a back-link Button). */
  readonly action?: React.ReactNode;
  readonly className?: string;
}

/**
 * Standard error state for detail-page load failures — icon in a muted circle,
 * bold title, optional description, optional action. Mirrors `EmptyState`'s
 * shape so error and empty paths read consistently.
 */
export function ErrorState({
  title,
  description,
  icon: Icon = AlertCircle,
  action,
  className,
}: ErrorStateProps) {
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
        {description && (
          <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
