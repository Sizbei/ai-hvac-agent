'use client';

import { GUIDE_COPY, progressLabel } from '@/lib/tech/guide-copy';

/** Spec §6: 6 px sunken track, primary fill, 300 ms ease-out, aria progressbar. The label is optional (the card's header carries its own count). */
export function GuideProgress({ done, total, showLabel = true }: { readonly done: number; readonly total: number; readonly showLabel?: boolean }) {
  const text = progressLabel(done, total);
  return (
    <div className="space-y-1.5">
      {showLabel && <p className="font-mono text-[13px] tabular-nums text-muted-foreground">{text}</p>}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={text}
        aria-label={GUIDE_COPY.progressAria}
        className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"
          style={{ width: `${total === 0 ? 0 : Math.round((done / total) * 100)}%` }}
        />
      </div>
    </div>
  );
}
