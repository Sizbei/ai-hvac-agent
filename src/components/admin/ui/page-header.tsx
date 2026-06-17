import { cn } from "@/lib/utils";

interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  /** Right-aligned actions slot (buttons, badges, counts). */
  readonly actions?: React.ReactNode;
  readonly className?: string;
}

/**
 * Standard admin page header: bold heading-font title + muted subtitle on the
 * left, right-aligned actions slot. Replaces the per-page hand-rolled
 * `flex items-center justify-between` header blocks.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-4",
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="font-heading text-2xl font-bold tracking-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
