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
  auto: 'border-info-border bg-info-light text-info-strong',
  'after-hours': 'border-warning-border bg-warning-light text-warning-strong',
  // Neutral chips sit on --surface-raised: a muted fill vanishes on sunken bands.
  queued: 'border-border bg-surface-raised text-muted-foreground',
  info: 'border-info-border bg-info-light text-info-strong',
  warning: 'border-warning-border bg-warning-light text-warning-strong',
  neutral: 'border-border bg-surface-raised text-muted-foreground',
};

export function ContextBadge({ variant = 'neutral', label, title, className }: ContextBadgeProps) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex h-5 items-center rounded-[3px] border px-1.5 text-[11px] font-medium leading-none',
        VARIANT_CLASSES[variant],
        className,
      )}
    >
      {label}
    </span>
  );
}
