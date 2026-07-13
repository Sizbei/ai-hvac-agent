'use client';

import { cn } from '@/lib/utils';
import { envName, envTone } from '@/lib/admin/environment';

const TONE_CLASSES: Record<string, string> = {
  destructive:
    'bg-destructive/10 text-destructive border border-destructive/30',
  warning: 'bg-amber-500/10 text-amber-600 border border-amber-500/30',
  positive: 'bg-emerald-500/10 text-emerald-600 border border-emerald-500/30',
};

/**
 * Small uppercase environment chip. Reads NEXT_PUBLIC_ENV_NAME at render time.
 * Production is the default/expected state — no chip there (a red "PRODUCTION"
 * sign on every page is just noise). We only surface a sign for non-prod
 * environments (test / staging / dev), where knowing you're off-prod matters.
 */
export function EnvBadge({ className }: { className?: string }) {
  const name = envName();
  if (name === 'production') return null;
  const tone = envTone(name);
  return (
    <span
      className={cn(
        'inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-widest',
        TONE_CLASSES[tone],
        className,
      )}
    >
      {name}
    </span>
  );
}
