import { cn } from "@/lib/utils";

interface PageShellProps {
  readonly children: React.ReactNode;
  readonly className?: string;
}

/**
 * Standard admin page wrapper: centers content, caps width, and applies the
 * refreshed-surface page padding + vertical rhythm. Replaces the per-page
 * `p-6 space-y-6` / no-padding drift across the dashboard.
 */
export function PageShell({ children, className }: PageShellProps) {
  return (
    <div
      className={cn("mx-auto max-w-[1280px] space-y-7 p-6 sm:p-7", className)}
    >
      {children}
    </div>
  );
}
