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
        <span className="text-xs font-medium text-muted-foreground">
          {done ? 'All details collected' : `Step ${collected} of ${total}`}
        </span>
        <div className="flex items-center gap-1.5">
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
