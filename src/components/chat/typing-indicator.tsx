'use client';

import { motion, useReducedMotion } from 'motion/react';

/**
 * "HVAC Assistant is typing…" indicator. Only mounted while the LLM-fallback
 * response is streaming — deterministic answers return instantly, so we never
 * fake latency on canned replies. Animation pauses under reduced-motion.
 */
export function TypingIndicator() {
  const reduceMotion = useReducedMotion();

  return (
    <div className="flex flex-col items-start gap-1" aria-live="polite">
      <div className="bg-surface-raised border border-border rounded-xl rounded-bl-md px-4 py-3">
        <div className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="size-1 bg-foreground-faint"
              animate={
                reduceMotion ? { opacity: 0.6 } : { opacity: [0.25, 1, 0.25] }
              }
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { duration: 1.2, repeat: Infinity, delay: i * 0.2 }
              }
            />
          ))}
        </div>
      </div>
      <span className="px-1 text-[11px] text-muted-foreground">
        HVAC Assistant is typing…
      </span>
    </div>
  );
}
