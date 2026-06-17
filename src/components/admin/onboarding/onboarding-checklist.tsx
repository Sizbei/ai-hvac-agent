'use client';

import { useEffect, useState } from 'react';
import { Check, Circle, X, Rocket } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface OnboardingStep {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
}

interface OnboardingState {
  readonly steps: readonly OnboardingStep[];
  readonly completedCount: number;
  readonly totalCount: number;
  readonly allComplete: boolean;
  readonly dismissed: boolean;
}

/**
 * Dismissible onboarding checklist for the /admin dashboard. Fetches live
 * completion state and renders a progress bar + the six steps. Hidden when the
 * org has dismissed it or every step is complete (a freshly-provisioned org sees
 * it; an established org never does).
 */
export function OnboardingChecklist() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let active = true;
    fetch('/api/admin/onboarding')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { data?: { onboarding?: OnboardingState } } | null) => {
        if (active && data?.data?.onboarding) {
          setState(data.data.onboarding);
        }
      })
      .catch(() => {
        /* degrade-safe: no checklist on error */
      });
    return () => {
      active = false;
    };
  }, []);

  async function handleDismiss() {
    // Optimistic: hide immediately, then persist.
    setHidden(true);
    try {
      await fetch('/api/admin/onboarding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissed: true }),
      });
    } catch {
      /* the optimistic hide stands even if the persist fails */
    }
  }

  // Hidden when: not loaded, locally dismissed, server-dismissed, or all done.
  if (!state || hidden || state.dismissed || state.allComplete) {
    return null;
  }

  const pct = Math.round((state.completedCount / state.totalCount) * 100);

  return (
    <Card className="border-primary/20">
      <CardHeader className="flex flex-row items-start justify-between gap-4 pb-3">
        <div className="flex items-center gap-2.5">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-[oklch(0.62_0.13_222)] text-primary-foreground shadow-sm">
            <Rocket className="size-4.5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">
              Finish setting up
            </p>
            <p className="text-xs text-muted-foreground">
              {state.completedCount} of {state.totalCount} complete
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss onboarding checklist"
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress bar */}
        <div
          className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary to-[oklch(0.62_0.13_222)] transition-[width] duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>

        <ul className="space-y-1.5">
          {state.steps.map((step) => (
            <li key={step.id} className="flex items-center gap-2.5 text-sm">
              {step.done ? (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                  <Check className="size-3.5" />
                </span>
              ) : (
                <Circle className="size-5 shrink-0 text-muted-foreground/40" />
              )}
              <span
                className={cn(
                  step.done
                    ? 'text-muted-foreground line-through'
                    : 'text-foreground',
                )}
              >
                {step.label}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
