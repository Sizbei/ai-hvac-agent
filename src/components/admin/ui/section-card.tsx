import type { LucideIcon } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardAction,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface SectionCardProps {
  /** Sentence-case card title, e.g. "Equipment history". */
  readonly title: string;
  /** Optional icon shown left of the title. */
  readonly icon?: LucideIcon;
  /** Optional numeric count shown as a muted badge next to the title. */
  readonly count?: number;
  /** Right-aligned action slot (button, link, badge, etc.). */
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
}

/**
 * Thin Card wrapper with a consistent header row + border-b divider.
 * Replaces per-page `Card` + hand-rolled header rows across reviews,
 * reports, integrations, insights, and detail pages.
 *
 * Title uses `font-heading` at ~15 px medium (CardTitle's default).
 * All text must be sentence-case; this component does not enforce it.
 */
export function SectionCard({
  title,
  icon: Icon,
  count,
  action,
  children,
  className,
  contentClassName,
}: SectionCardProps) {
  return (
    <Card className={className}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2">
          {Icon && (
            <Icon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          )}
          {title}
          {count !== undefined && (
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              ({count})
            </span>
          )}
        </CardTitle>
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent className={cn("pt-4", contentClassName)}>
        {children}
      </CardContent>
    </Card>
  );
}
