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
      className={`w-fit shrink-0 self-start rounded-[3px] border border-border-strong bg-surface-raised font-medium text-muted-foreground ${
        size === 'sm' ? 'px-1 py-px text-[9px]' : 'px-1.5 py-px text-[10px]'
      }`}
    >
      {LABELS[source][size]}
    </span>
  );
}
