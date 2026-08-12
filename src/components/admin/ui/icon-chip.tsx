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
  primary: "bg-primary-soft text-marker-strong",
  success: "bg-success-light text-success-strong",
  warning: "bg-warning-light text-warning-strong",
  danger: "bg-danger-light text-danger-strong",
  info: "bg-info-light text-info-strong",
  neutral: "bg-surface-sunken text-muted-foreground",
};

/**
 * Small tinted glyph square for LIST ROWS, where the icon disambiguates the
 * record type. Deliberately quiet: 4 px radius, `*-light` fill, `*-strong`
 * glyph, tokens only.
 *
 * Not for KPI cells — the redesign spec bans tinted chips there (see
 * `stat-card.tsx`).
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
        "flex shrink-0 items-center justify-center rounded-sm",
        size === "md" ? "size-8 [&>svg]:size-4" : "size-6 [&>svg]:size-3.5",
        INTENT_CLASSES[intent],
        className,
      )}
    >
      <Icon aria-hidden="true" />
    </span>
  );
}
