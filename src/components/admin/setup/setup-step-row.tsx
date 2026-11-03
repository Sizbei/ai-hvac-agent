'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ContextBadge } from '@/components/admin/ui/context-badge';
import { StepGlyph } from '@/components/admin/ui/step-glyph';
import { CopySignInLink } from '@/components/admin/setup/copy-sign-in-link';
import { rowActionsFor, type StepRow } from '@/lib/admin/setup-view';
import { cn } from '@/lib/utils';

interface SetupStepRowProps {
  readonly row: StepRow;
  /** The step flipped to done since the last snapshot: run the enter transition. */
  readonly justDone?: boolean;
  /** Step id the hero shows; its row drops the repeated primary action. */
  readonly heroId?: string;
}

/** Enter from-state for one frame so the opacity/translate transition runs. */
function useEnterFrom(active: boolean): boolean {
  const [from, setFrom] = useState(active);
  useEffect(() => {
    if (!from) return;
    // Two frames: the first guarantees the from-state has been painted.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setFrom(false));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [from]);
  return from;
}

const ROW_BUTTON = 'max-sm:min-h-11';

function RowActions({ row, heroId }: { row: StepRow; heroId?: string }) {
  const { step } = row;
  if (step.done) return <span className="text-[13px] text-muted-foreground">Done</span>;
  const show = rowActionsFor(step, heroId);
  return (
    <>
      {show.primary && step.href && (
        <Button variant="outline" size="sm" className={ROW_BUTTON} render={<Link href={step.href} />}>
          {step.hrefLabel}
        </Button>
      )}
      {show.secondary && step.secondaryHref && (
        <Button variant="outline" size="sm" className={ROW_BUTTON} render={<Link href={step.secondaryHref} />}>
          {step.secondaryLabel}
        </Button>
      )}
    </>
  );
}

/** One setup-guide row: glyph, title, why, note, estimate and the step's link. */
export function SetupStepRow({ row, justDone = false, heroId }: SetupStepRowProps) {
  const { step, number } = row;
  const from = useEnterFrom(justDone);
  const glyph = step.done ? 'done' : step.needsAttention ? 'attention' : 'todo';
  const copyUrl =
    step.action === 'copy_sign_in_link' && rowActionsFor(step, heroId).primary
      ? step.copyValue
      : undefined;

  return (
    <li
      data-just-done={justDone || undefined}
      className={cn(
        'flex gap-3 py-3 first:pt-0 last:pb-0',
        justDone && 'transition-[opacity,transform] duration-[var(--dur-enter)] ease-[var(--ease-out)]',
        from && 'translate-y-1 opacity-0',
      )}
    >
      <StepGlyph state={glyph} number={number} className="mt-0.5" />
      <div className="min-w-0 flex-1 sm:flex sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className={cn('text-[14px] font-medium leading-5', step.done ? 'text-muted-foreground' : 'text-foreground')}>
              {step.title}
            </p>
            {!step.required && <ContextBadge variant="neutral" label="Optional" />}
          </div>
          <p className="text-[13px] leading-5 text-muted-foreground">{step.why}</p>
          {step.note && (
            <p className={cn('text-[13px] leading-5', step.done || !step.needsAttention ? 'text-muted-foreground' : 'text-warning-strong')}>
              {step.note}
            </p>
          )}
          {copyUrl && (
            <div className="pt-2">
              <CopySignInLink url={copyUrl} instruction={step.instruction ?? ''} />
            </div>
          )}
        </div>
        <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2 sm:mt-0 sm:justify-end">
          {!step.done && (
            <span className="font-mono text-[12px] tabular-nums text-muted-foreground">{step.estimateLabel}</span>
          )}
          <RowActions row={row} heroId={heroId} />
        </div>
      </div>
    </li>
  );
}
