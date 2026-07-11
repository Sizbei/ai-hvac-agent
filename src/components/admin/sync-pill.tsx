'use client';

const LABELS = { fieldpulse: { sm: 'FP', md: 'FieldPulse' }, housecall: { sm: 'HCP', md: 'Housecall Pro' } } as const;

/** The one provenance pill. sm = dense grids (calendar chips, cards); md = list rows and headers. */
export function SyncPill({
  source,
  size = 'md',
}: {
  readonly source: 'fieldpulse' | 'housecall' | null | undefined;
  readonly size?: 'sm' | 'md';
}) {
  if (!source) return null;
  return (
    <span
      className={`shrink-0 rounded border bg-violet-50 font-semibold text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300 ${
        size === 'sm' ? 'px-1 py-px text-[9px]' : 'px-1.5 py-px text-[10px]'
      }`}
    >
      {LABELS[source][size]}
    </span>
  );
}
