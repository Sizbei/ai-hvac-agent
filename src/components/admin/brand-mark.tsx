import { Wind } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BrandMarkProps {
  /** Hide the wordmark text and show only the logo lozenge (collapsed sidebar). */
  readonly compact?: boolean;
  /** Render the wordmark in light ink for dark/navy surfaces (the sidebar). */
  readonly onDark?: boolean;
  readonly className?: string;
}

/**
 * The Spears Services brand mark used across the admin shell: a cyan logo
 * lozenge plus a two-line wordmark ("Spears Services" / "Service Console").
 * Colors come from the brand tokens so light and dark themes both read well.
 */
export function BrandMark({ compact = false, onDark = false, className }: BrandMarkProps) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-xl shadow-sm',
          'bg-gradient-to-br from-primary to-[oklch(0.62_0.13_222)] text-primary-foreground',
        )}
      >
        <Wind className="size-5" />
      </span>
      {!compact && (
        <span className="flex min-w-0 flex-col leading-none">
          <span
            className={cn(
              'font-heading text-[15px] font-bold tracking-tight',
              onDark ? 'text-white' : 'text-foreground',
            )}
          >
            Spears Services
          </span>
          <span
            className={cn(
              'mt-1 text-[11px] font-medium uppercase tracking-[0.14em]',
              onDark ? 'text-white/55' : 'text-muted-foreground',
            )}
          >
            Service Console
          </span>
        </span>
      )}
    </div>
  );
}
