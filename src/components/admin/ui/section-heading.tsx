import { cn } from "@/lib/utils";

interface SectionHeadingProps {
  /**
   * Heading level — h2 for top-level card sections, h3 for nested.
   * Defaults to "h2".
   */
  readonly as?: "h2" | "h3";
  /** Sentence-case title (~14–15 px medium). */
  readonly title: string;
  /** Optional 12 px muted descriptor rendered below the title. */
  readonly description?: string;
  /** Right-aligned slot: badge, link, or action button. */
  readonly right?: React.ReactNode;
  readonly className?: string;
}

/**
 * Card-level heading with consistent type hierarchy:
 * ~15 px medium title + optional 12 px muted descriptor + right slot.
 *
 * Replaces the `text-xs font-semibold uppercase tracking-wide text-muted-foreground`
 * pattern in integrations, fieldpulse-import, dispatch exceptions, and reports
 * subheads. Those uppercase-tracking labels MUST be changed to sentence-case
 * copy when adopting this primitive.
 *
 * No `uppercase` or `tracking-[…]` — those are reserved for BrandMark / nav
 * eyebrows only (see Global Constraints in the design plan).
 */
export function SectionHeading({
  as: Tag = "h2",
  title,
  description,
  right,
  className,
}: SectionHeadingProps) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="space-y-0.5">
        <Tag className="text-[15px] font-medium leading-snug text-foreground">
          {title}
        </Tag>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      {right && (
        <div className="shrink-0">{right}</div>
      )}
    </div>
  );
}
