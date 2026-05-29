'use client';

import { PhoneForwarded } from 'lucide-react';

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
          className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none"
        >
          {s.label}
        </button>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={onEscalate}
        className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-50 px-3 py-1.5 text-xs font-medium text-orange-700 transition-colors hover:bg-orange-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:pointer-events-none"
      >
        <PhoneForwarded className="size-3" />
        Talk to a human
      </button>
    </div>
  );
}
