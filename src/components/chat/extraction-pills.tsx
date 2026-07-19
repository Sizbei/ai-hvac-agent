'use client';

import { motion, useReducedMotion } from 'motion/react';
import { Check } from 'lucide-react';
import { ANIMATION } from '@/lib/design-tokens';
import { cn } from '@/lib/utils';
import type { ExtractionField } from '@/lib/types/chat';

interface ExtractionPillsProps {
  readonly fields: readonly ExtractionField[];
}

/**
 * Intake progress stepper. Shows "Step X of N" with a slim progress bar and a
 * checkable chip per required field, so customers see the finish line rather
 * than a loose set of tags (NN/G progress-disclosure pattern).
 *
 * On narrow viewports (≤375px) the chips are replaced by compact dot indicators
 * so no chip is ever clipped off-screen.
 */
export function ExtractionPills({ fields }: ExtractionPillsProps) {
  const reduceMotion = useReducedMotion();
  const collected = fields.filter((f) => f.collected).length;
  const total = fields.length;

  // Hide until the customer has supplied at least one field.
  if (collected === 0) return null;

  const pct = total > 0 ? Math.round((collected / total) * 100) : 0;
  const done = collected === total;

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: ANIMATION.fadeIn.duration,
        ease: ANIMATION.fadeIn.ease,
      }}
      className="px-3 py-2"
      aria-label={`Intake progress: ${collected} of ${total} details collected`}
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-medium text-muted-foreground shrink-0">
          {done ? 'All details collected' : `Step ${collected} of ${total}`}
        </span>

        {/* Dot stepper — always visible, compact enough for 375px */}
        <div className="flex items-center gap-1.5 ml-2" aria-hidden>
          {fields.map((field) => (
            <motion.span
              key={field.key}
              title={field.label}
              className={cn(
                'inline-flex items-center justify-center rounded-full transition-colors duration-150',
                field.collected
                  ? 'size-5 bg-green-500 text-white'
                  : 'size-2.5 bg-muted border border-border',
              )}
              animate={
                reduceMotion
                  ? {}
                  : field.collected
                    ? { scale: [1, 1.25, 1] }
                    : { scale: 1 }
              }
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              {field.collected && <Check className="size-3" aria-hidden />}
            </motion.span>
          ))}
        </div>
      </div>

      {/* Chip row — visible on wider viewports only, wraps safely */}
      <div className="hidden sm:flex flex-wrap items-center gap-1 mb-1.5">
        {fields.map((field) => (
          <span
            key={field.key}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors',
              field.collected
                ? 'border-green-200 bg-green-50 text-green-700'
                : 'border-border bg-muted/50 text-muted-foreground',
            )}
          >
            {field.collected && <Check className="size-3" aria-hidden />}
            {field.label}
          </span>
        ))}
      </div>

      <div
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={collected}
        aria-valuemin={0}
        aria-valuemax={total}
      >
        <motion.div
          className={cn('h-full rounded-full', done ? 'bg-green-500' : 'bg-primary')}
          initial={reduceMotion ? false : { width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: reduceMotion ? 0 : 0.35, ease: 'easeOut' }}
        />
      </div>
    </motion.div>
  );
}
