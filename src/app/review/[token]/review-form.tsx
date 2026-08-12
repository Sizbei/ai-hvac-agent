'use client';

import { useState } from 'react';
import { Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface ReviewFormProps {
  readonly token: string;
  /** Resolved server-side; shown to EVERYONE after submit (no sentiment gate). */
  readonly publicReviewUrl: string;
}

/**
 * Public review form: pick 1-5 stars, optionally add feedback, submit. After
 * submitting we thank the customer AND offer the public-review link regardless
 * of the rating they gave — there is no branch hiding the link from low raters
 * (FTC / Google ToS: no review-gating).
 */
export function ReviewForm({ token, publicReviewUrl }: ReviewFormProps) {
  const [rating, setRating] = useState(0);
  const [hovered, setHovered] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function handleSubmit(): Promise<void> {
    if (rating < 1) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/review/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rating,
          feedback: feedback.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setDone(true);
      } else if (res.status === 409) {
        // Already responded — still show the thank-you + link (no gating).
        setDone(true);
      } else {
        setError(body.error?.message ?? 'Could not submit your review.');
      }
    } catch {
      setError('Could not connect to the server. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="rounded-lg border border-success-border bg-success-light p-6 text-center">
        <p className="text-[17px] font-semibold text-success-strong">
          Thank you for your feedback!
        </p>
        <p className="mt-1 text-[15px] text-foreground">
          We truly appreciate it. If you have a moment, a public review really
          helps us out.
        </p>
        <a
          href={publicReviewUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex min-h-11 items-center justify-center rounded-xl bg-primary px-5 text-[15px] font-semibold text-primary-foreground transition-[background-color] duration-[var(--dur-hover)] hover:bg-primary-deep"
        >
          Leave a public review
        </a>
      </div>
    );
  }

  const active = hovered || rating;

  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-2">
        <div
          className="flex items-center gap-1"
          role="radiogroup"
          aria-label="Star rating"
        >
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={rating === value}
              aria-label={`${value} star${value > 1 ? 's' : ''}`}
              onClick={() => setRating(value)}
              onMouseEnter={() => setHovered(value)}
              onMouseLeave={() => setHovered(0)}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-xl p-1 outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            >
              <Star
                className={cn(
                  'size-9 transition-colors duration-[var(--dur-hover)]',
                  value <= active
                    ? 'fill-warning text-warning'
                    : 'text-foreground-faint',
                )}
              />
            </button>
          ))}
        </div>
        {rating > 0 && (
          <p className="text-[15px] text-muted-foreground">
            You rated us {rating} out of 5.
          </p>
        )}
      </div>

      <div className="space-y-2">
        <label
          htmlFor="review-feedback"
          className="text-[15px] font-medium text-foreground"
        >
          Anything you&apos;d like to share? (optional)
        </label>
        <Textarea
          id="review-feedback"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          rows={4}
          maxLength={2000}
          placeholder="Tell us about your experience…"
          className="resize-y rounded-xl p-3 text-[15px] md:text-[15px]"
        />
        <p className="text-[13px] text-muted-foreground">
          Your written feedback is private and goes straight to our team.
        </p>
      </div>

      {error && <p className="text-[15px] text-danger-strong">{error}</p>}

      <Button
        className="h-11 w-full rounded-xl text-[15px]"
        disabled={isSubmitting || rating < 1}
        onClick={handleSubmit}
      >
        {isSubmitting ? 'Submitting…' : 'Submit feedback'}
      </Button>
    </div>
  );
}
