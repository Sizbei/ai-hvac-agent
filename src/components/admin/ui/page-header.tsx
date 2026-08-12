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
 * Standard admin page header: 20 px/600 title + 13 px muted description on the
 * left, actions sitting on the title baseline at the right.
 *
 * The 20 px gap to the first section is supplied by `PageShell`'s vertical
 * rhythm (`space-y-5`); pass `className="mb-5"` when using this outside the
 * shell.
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
        "flex flex-wrap items-start justify-between gap-x-4 gap-y-2",
        className,
      )}
    >
      <div className="min-w-0">
        {back && (
          <Link
            href={back.href}
            className="mb-1.5 inline-flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden="true" />
            {back.label ?? "Back"}
          </Link>
        )}
        <h1 className="text-[20px] font-semibold leading-[26px] tracking-[-0.02em] text-foreground">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2 self-start">
          {actions}
        </div>
      )}
    </div>
  );
}
