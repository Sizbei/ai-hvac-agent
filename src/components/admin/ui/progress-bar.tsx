import { cn } from "@/lib/utils";

export type ProgressBarIntent = "success" | "warning" | "danger" | "info" | "neutral";

interface ProgressBarProps {
  /** 0–100 */
  readonly value: number;
  readonly max?: number;
  readonly intent?: ProgressBarIntent;
  readonly label?: string;
  readonly className?: string;
}

const TRACK_CLASSES: Record<ProgressBarIntent, string> = {
  success: "bg-success",
  warning: "bg-warning-strong",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-marker",
};

/**
 * Accessible progress bar using semantic tokens: a 4 px sunken track with a
 * flat fill (`--marker` by default). Replaces the inline `bg-emerald-500` /
 * `bg-amber-500` / `bg-rose-500` bars in the AR aging section of operations.
 *
 * `role="progressbar"` with `aria-valuenow`, `aria-valuemin`, `aria-valuemax`
 * for screen-reader compatibility. Dark-mode-safe via token colors only.
 */
export function ProgressBar({
  value,
  max = 100,
  intent = "neutral",
  label,
  className,
}: ProgressBarProps) {
  const safeValue = Number.isFinite(value) ? value : 0;
  const clamped = Math.min(100, Math.max(0, max > 0 ? (safeValue / max) * 100 : 0));

  return (
    <span
      role="progressbar"
      aria-valuenow={safeValue}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label ?? "Progress"}
      className={cn(
        "block h-1 w-full overflow-hidden rounded-[2px] bg-surface-sunken",
        className,
      )}
    >
      <span
        className={cn("block h-full rounded-[2px]", TRACK_CLASSES[intent])}
        style={{ width: `${clamped}%` }}
        aria-hidden="true"
      />
    </span>
  );
}
