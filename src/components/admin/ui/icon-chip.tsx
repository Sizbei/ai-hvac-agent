import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type IconChipIntent =
  | "primary"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral";

interface IconChipProps {
  readonly icon: LucideIcon;
  readonly intent?: IconChipIntent;
  readonly size?: "sm" | "md";
  readonly className?: string;
}

/** Maps intent → token-based background + foreground classes. */
const INTENT_CLASSES: Record<IconChipIntent, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success-light text-success",
  warning: "bg-warning-light text-warning",
  danger: "bg-danger-light text-danger",
  info: "bg-info-light text-info",
  neutral: "bg-muted text-muted-foreground",
};

/**
 * Coloured icon container: replaces the ~30 ad-hoc
 * `bg-green-100 dark:bg-green-900/30` chip patterns across the admin.
 *
 * Styling uses only semantic design tokens — no raw Tailwind palette classes.
 */
export function IconChip({
  icon: Icon,
  intent = "neutral",
  size = "md",
  className,
}: IconChipProps) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg",
        size === "md" ? "size-9 [&>svg]:size-5" : "size-7 [&>svg]:size-4",
        INTENT_CLASSES[intent],
        className,
      )}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}
