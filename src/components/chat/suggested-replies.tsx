'use client';

import { PhoneForwarded } from 'lucide-react';
import { cn } from '@/lib/utils';

// De-pilled machined key: 6px radius, hairline input border, 44px touch height,
// colour-only transition with a 0.5px mechanical settle on press.
const CHIP_BASE =
  'inline-flex min-h-11 items-center rounded-md border px-3 text-[13px] font-medium transition-[background-color,border-color,color] duration-[var(--dur-hover)] ease-[var(--ease-out)] active:translate-y-[0.5px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-50 disabled:pointer-events-none';

export interface Suggestion {
  readonly label: string;
  readonly message: string;
}

interface SuggestedRepliesProps {
  readonly suggestions: readonly Suggestion[];
  readonly onSelect: (message: string) => void;
  readonly onEscalate: () => void;
  readonly disabled?: boolean;
}

/**
 * Contextual next-step chips shown after a bot turn (Drift / NN/G "suggested
 * prompts" pattern). Keeps the customer on rails and reduces typing on mobile.
 * Always offers a one-tap human handoff.
 */
export function SuggestedReplies({
  suggestions,
  onSelect,
  onEscalate,
  disabled,
}: SuggestedRepliesProps) {
  return (
    <div
      className="flex flex-wrap gap-1.5 px-3 pb-2"
      role="group"
      aria-label="Suggested replies"
    >
      {suggestions.map((s) => (
        <button
          key={s.label}
          type="button"
          disabled={disabled}
          onClick={() => onSelect(s.message)}
          className={cn(CHIP_BASE, 'border-border-input bg-surface-raised text-foreground hover:bg-accent')}
        >
          {s.label}
        </button>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={onEscalate}
        className={cn(CHIP_BASE, 'gap-1 border-warning-border bg-warning-light text-warning-strong hover:bg-warning-light/70')}
      >
        <PhoneForwarded className="size-3" />
        Talk to a human
      </button>
    </div>
  );
}
