import { cn } from '@/lib/utils';

export type ContextBadgeVariant = 'auto' | 'after-hours' | 'queued' | 'info' | 'warning' | 'neutral';

interface ContextBadgeProps {
  readonly variant?: ContextBadgeVariant;
  readonly label: string;
  readonly title?: string;
  readonly className?: string;
}

/** Token-based inline metadata chip for contextual signals (Auto, After-hrs, queued
 *  outcome, etc.). Replaces the hand-rolled sky/amber chips in dispatch-column,
 *  request-table, and dashboard-list-card. No raw palette classes. */
const VARIANT_CLASSES: Record<ContextBadgeVariant, string> = {
  auto: 'border-info/30 bg-info-light text-info-foreground',
  'after-hours': 'border-warning/30 bg-warning-light text-warning-foreground',
  queued: 'border-border bg-muted text-muted-foreground',
  info: 'border-info/30 bg-info-light text-info-foreground',
  warning: 'border-warning/30 bg-warning-light text-warning-foreground',
  neutral: 'border-border bg-muted text-muted-foreground',
};

export function ContextBadge({ variant = 'neutral', label, title, className }: ContextBadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      {label}
    </span>
  );
}
