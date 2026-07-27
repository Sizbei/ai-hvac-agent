import { cn } from "@/lib/utils";

interface PageShellProps {
  readonly children: React.ReactNode;
  readonly className?: string;
  /** Caps content width at max-w-3xl for single-panel pages (settings, billing, accounting). */
  readonly narrow?: boolean;
  /** Drops max-width and vertical padding for full-bleed surfaces like the map.
   *  The page is responsible for its own header strip. */
  readonly fullHeight?: boolean;
}

/**
 * Standard admin page wrapper: centers content, caps width, and applies the
 * refreshed-surface page padding + vertical rhythm. Replaces the per-page
 * `p-6 space-y-6` / no-padding drift across the dashboard.
 */
export function PageShell({ children, className, narrow, fullHeight }: PageShellProps) {
  if (fullHeight) {
    return (
      <div className={cn("flex h-full flex-col", className)}>
        {children}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "mx-auto space-y-7 p-6 sm:p-7",
        narrow ? "max-w-3xl" : "max-w-[1280px]",
        className,
      )}
    >
      {children}
    </div>
  );
}
