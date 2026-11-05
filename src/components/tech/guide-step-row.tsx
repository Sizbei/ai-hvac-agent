'use client';

import { useState } from 'react';
import { Check } from 'lucide-react';
import { GUIDE_COPY } from '@/lib/tech/guide-copy';
import type { DerivedStep } from '@/lib/tech/guide-steps';
import type { Glyph } from '@/lib/tech/guide-view';

const SR: Record<Glyph, string> = { done: GUIDE_COPY.srDone, next: GUIDE_COPY.srUpNext, todo: GUIDE_COPY.srTodo };

/** Glyph: Check for done (fades in 180 ms only when it flipped while mounted), filled dot for up next, ring otherwise. */
function StepGlyph({ glyph, flipped }: { readonly glyph: Glyph; readonly flipped: boolean }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      {glyph === 'done' ? (
        <Check className={`size-4 text-success-strong ${flipped ? 'animate-in fade-in duration-[180ms] motion-reduce:animate-none' : ''}`} aria-hidden="true" />
      ) : (
        <span aria-hidden="true" className={glyph === 'next' ? 'size-2 rounded-full bg-primary' : 'size-2 rounded-full border border-border-strong'} />
      )}
      <span className="sr-only">{SR[glyph]}</span>
    </span>
  );
}

/** One step row: glyph, title, Lead only chip, how + note (both hidden on the hero's own step). */
export function GuideStepRow({ step, glyph, showHow }: { readonly step: DerivedStep; readonly glyph: Glyph; readonly showHow: boolean }) {
  // Previous-value-in-state (never a ref read during render): the fade runs only on a flip while mounted.
  const [prevDone, setPrevDone] = useState(step.done);
  const [flipped, setFlipped] = useState(false);
  if (step.done !== prevDone) {
    setPrevDone(step.done);
    setFlipped(step.done);
  }
  return (
    <li className="flex min-h-11 gap-3 py-2.5">
      <div className="pt-0.5"><StepGlyph glyph={glyph} flipped={flipped} /></div>
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
          {step.title}
          {step.leadOnly && (
            <span className="rounded-[3px] border border-border px-1.5 text-[11px] font-medium text-muted-foreground">{GUIDE_COPY.leadOnly}</span>
          )}
        </p>
        {showHow && <p className="text-[13px] text-muted-foreground">{step.how}</p>}
        {showHow && step.note && <p className="text-[13px] text-muted-foreground">{step.note}</p>}
      </div>
    </li>
  );
}
