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
 * Standard error state for detail-page load failures — 20 px glyph in a 40 px
 * sunken square, 15 px headline, optional 13 px muted line, optional action.
 * Mirrors `EmptyState`'s shape so error and empty paths read consistently.
 *
 * Copy stays human: no `err.message`, no codes.
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
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="flex size-10 items-center justify-center rounded-md bg-surface-sunken text-danger-strong">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="space-y-1">
        <p className="text-[15px] font-medium leading-5 text-foreground">
          {title}
        </p>
        {description && (
          <p className="max-w-sm text-[13px] leading-5 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
