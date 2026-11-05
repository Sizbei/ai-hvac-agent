import { ChevronDown, type LucideIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface SectionCardBaseProps {
  /** Sentence-case card title, e.g. "Equipment history". */
  readonly title: string;
  /** Optional icon shown left of the title. */
  readonly icon?: LucideIcon;
  /** Optional short mono note in the header, before `count` (e.g. "2 of 4"). */
  readonly meta?: string;
  /** Optional numeric count shown as a mono figure next to the title. */
  readonly count?: number;
  /**
   * Optional one-line explanation of the panel, shown under the header band
   * (wraps on phones). Use this, not `meta` or `action`, for sentence-length
   * copy: header slots are single-line and would squeeze the title.
   */
  readonly description?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
}

/** Plain panel: may carry a right-aligned header action. */
interface StaticSectionCardProps extends SectionCardBaseProps {
  readonly collapsible?: false;
  /** Right-aligned action slot (button, link, badge, etc.). */
  readonly action?: React.ReactNode;
  readonly open?: never;
}

/**
 * Native `<details>` whose header is the `<summary>`. No `action`: a control
 * inside a `<summary>` would toggle the panel.
 */
interface CollapsibleSectionCardProps extends SectionCardBaseProps {
  readonly collapsible: true;
  readonly action?: never;
  /** Open state; re-applied whenever it changes, user toggles kept otherwise. */
  readonly open?: boolean;
}

type SectionCardProps = StaticSectionCardProps | CollapsibleSectionCardProps;

// min-h + flex-wrap: on a narrow phone the action drops to its own line rather
// than squeezing the title to nothing.
const HEADER_CLASSES =
  "flex min-h-10 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-strong bg-surface-sunken px-4 py-1";

/**
 * Panel — the one boxed surface of the admin: `--surface` body, 1 px
 * `--border-strong` hairline, 6 px radius, no shadow, and a 40 px sunken
 * header band with a top keyline separating it from the body.
 *
 * Title is 15 px/600 sentence case; the optional count renders as a bare
 * tabular-mono figure (no badge). All text must be sentence-case; this
 * component does not enforce it.
 */
export function SectionCard({
  title,
  icon: Icon,
  meta,
  count,
  description,
  action,
  children,
  className,
  contentClassName,
  collapsible = false,
  open = true,
}: SectionCardProps) {
  const heading = (
    <>
      {Icon && (
        <Icon
          className="size-3.5 shrink-0 text-foreground-faint"
          aria-hidden="true"
        />
      )}
      {/* The title never yields to meta: it truncates only when it alone is
          wider than the header. Meta is the part that shrinks. */}
      <h2 className="max-w-full shrink-0 truncate text-[15px] font-semibold leading-none text-foreground">
        {title}
      </h2>
      {meta && (
        <span className="min-w-0 truncate font-mono text-[13px] leading-none tabular-nums text-muted-foreground">
          {meta}
        </span>
      )}
      {count !== undefined && (
        <span className="font-mono text-[13px] leading-none tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </>
  );

  const descriptionLine = description ? (
    <p className="border-b border-border px-4 py-2 text-xs leading-5 text-muted-foreground">
      {description}
    </p>
  ) : null;

  if (collapsible) {
    return (
      <details
        open={open}
        className={cn(
          "group/section overflow-hidden rounded-lg border border-border-strong bg-surface text-sm",
          className,
        )}
      >
        <summary
          className={cn(
            HEADER_CLASSES,
            "cursor-pointer list-none outline-none group-not-open/section:border-b-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden",
          )}
          style={{ boxShadow: "var(--keyline-top)" }}
        >
          {heading}
          <ChevronDown
            aria-hidden="true"
            className="ml-auto size-4 shrink-0 text-foreground-faint transition-transform duration-[var(--dur-hover)] group-open/section:rotate-180"
          />
        </summary>
        {descriptionLine}
        <div className={cn("p-4", contentClassName)}>{children}</div>
      </details>
    );
  }

  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden rounded-lg border border-border-strong bg-surface p-0 shadow-none ring-0",
        className,
      )}
    >
      <div
        className={HEADER_CLASSES}
        style={{ boxShadow: "var(--keyline-top)" }}
      >
        {heading}
        {action && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {action}
          </div>
        )}
      </div>
      {descriptionLine}
      <div className={cn("p-4", contentClassName)}>{children}</div>
    </Card>
  );
}
