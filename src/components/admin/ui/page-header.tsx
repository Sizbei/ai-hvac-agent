import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

interface BackLink {
  readonly href: string;
  readonly label?: string;
}

interface PageHeaderProps {
  readonly title: string;
  readonly subtitle?: string;
  /** When provided, renders an ArrowLeft ghost back-link before the title. */
  readonly back?: BackLink;
  /** Right-aligned actions slot (buttons, badges, counts). */
  readonly actions?: React.ReactNode;
  readonly className?: string;
}

/**
 * Standard admin page header: bold heading-font title + muted subtitle on the
 * left, right-aligned actions slot. Replaces the per-page hand-rolled
 * `flex items-center justify-between` header blocks.
 *
 * Pass `back={{ href, label? }}` to render an ArrowLeft ghost back-link before
 * the title (replaces bespoke back-headers in detail pages).
 */
export function PageHeader({
  title,
  subtitle,
  back,
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
        {back && (
          <Link
            href={back.href}
            className="mb-1 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {back.label ?? "Back"}
          </Link>
        )}
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
