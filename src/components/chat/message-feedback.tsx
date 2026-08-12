'use client';

import { useState, useCallback } from 'react';
import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MessageFeedbackProps {
  /** Index of the message in the conversation (stable identifier for the vote). */
  readonly messageIndex: number;
}

type Vote = 'up' | 'down';

/**
 * "Was this helpful? 👍 / 👎" control shown under assistant answers (Zendesk
 * pattern). Fire-and-forget POST to /api/session/feedback; failures are silent
 * (feedback is best-effort and must never block the chat).
 */
export function MessageFeedback({ messageIndex }: MessageFeedbackProps) {
  const [vote, setVote] = useState<Vote | null>(null);

  const submit = useCallback(
    (next: Vote) => {
      if (vote) return;
      setVote(next);
      void fetch('/api/session/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vote: next, messageIndex }),
      }).catch(() => {
        // Best-effort; ignore network errors.
      });
    },
    [vote, messageIndex],
  );

  if (vote) {
    return (
      <p className="mt-1 px-1 text-[11px] text-muted-foreground" role="status">
        Thanks for the feedback!
      </p>
    );
  }

  return (
    <div className="mt-1 flex items-center gap-2 px-1" aria-label="Was this helpful?">
      <span className="text-[11px] text-muted-foreground">Was this helpful?</span>
      <button
        type="button"
        onClick={() => submit('up')}
        aria-label="Yes, this was helpful"
        className={cn(
          'relative size-7 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-success',
          "before:absolute before:-inset-2 before:content-['']",
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        )}
      >
        <ThumbsUp className="mx-auto size-3.5" />
      </button>
      <button
        type="button"
        onClick={() => submit('down')}
        aria-label="No, this was not helpful"
        className={cn(
          'relative size-7 rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-danger',
          "before:absolute before:-inset-2 before:content-['']",
          'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
        )}
      >
        <ThumbsDown className="mx-auto size-3.5" />
      </button>
    </div>
  );
}
