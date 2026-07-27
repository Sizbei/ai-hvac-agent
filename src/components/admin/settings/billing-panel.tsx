'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Check, Loader2 } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ALL_PLANS } from '@/lib/billing/plans';
import { formatCentsExact } from '@/lib/admin/money-format';
import { cn } from '@/lib/utils';

interface BillingState {
  readonly plan: { id: string; label: string; priceCents: number; interval: string };
  readonly status: string;
  readonly active: boolean;
  readonly currentPeriodEnd: string | null;
  readonly entitlements: {
    maxStaff: number;
    maxConversationsPerMonth?: number;
    features: readonly string[];
  };
}

function formatPrice(cents: number): string {
  if (cents === 0) return 'Free';
  return formatCentsExact(cents);
}

/**
 * Billing settings panel. Reads current plan/status/entitlements from the
 * super_admin-gated endpoint, lists selectable plans with upgrade buttons
 * (checkout) and a "Manage billing" portal button. Both actions open the URL the
 * provider returns (a placeholder in the mock world — no real charges).
 */
export function BillingPanel() {
  const [state, setState] = useState<BillingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/platform/billing');
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json?.error?.message ?? 'Failed to load billing.');
        return;
      }
      setState(json.data as BillingState);
      setError(null);
    } catch {
      setError('Failed to load billing.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (body: Record<string, unknown>, busyKey: string) => {
      setBusyAction(busyKey);
      setError(null);
      try {
        const res = await fetch('/api/platform/billing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          setError(json?.error?.message ?? 'Something went wrong.');
          return;
        }
        if (typeof json.data?.url === 'string') {
          window.location.href = json.data.url;
        }
      } catch {
        setError('Something went wrong.');
      } finally {
        setBusyAction(null);
      }
    },
    [],
  );

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (!state) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertDescription>{error ?? 'Billing unavailable.'}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div>
              <CardTitle>Current plan</CardTitle>
              <CardDescription>
                {state.plan.label} · {formatPrice(state.plan.priceCents)}
                {state.plan.priceCents > 0 ? `/${state.plan.interval}` : ''}
              </CardDescription>
            </div>
            <Badge
              variant="outline"
              className={cn(
                'capitalize',
                state.active
                  ? 'bg-success-light text-success border-success/30'
                  : 'bg-danger-light text-danger border-danger/30',
              )}
            >
              {state.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <ul className="space-y-1.5 text-muted-foreground">
            <li className="flex items-center gap-2">
              <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
              Up to {state.entitlements.maxStaff} staff members
            </li>
            {state.entitlements.maxConversationsPerMonth !== undefined && (
              <li className="flex items-center gap-2">
                <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
                {state.entitlements.maxConversationsPerMonth.toLocaleString()}{' '}
                conversations / month
              </li>
            )}
            {state.entitlements.features.map((feature) => (
              <li key={feature} className="flex items-center gap-2">
                <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
                {feature}
              </li>
            ))}
          </ul>
          {state.currentPeriodEnd && (
            <p className="text-xs text-muted-foreground">
              Current period ends{' '}
              {new Date(state.currentPeriodEnd).toLocaleDateString()}
            </p>
          )}
          <Button
            variant="outline"
            disabled={busyAction !== null}
            onClick={() => post({ action: 'portal' }, 'portal')}
          >
            {busyAction === 'portal' && (
              <Loader2 className="size-4 animate-spin" />
            )}
            Manage billing
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
          <CardDescription>Choose the plan that fits your team.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {ALL_PLANS.map((plan) => {
            const isCurrent = plan.id === state.plan.id;
            return (
              <Card
                key={plan.id}
                className={cn(
                  'flex flex-row items-center justify-between gap-4 p-4',
                  isCurrent && 'border-primary',
                )}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{plan.label}</span>
                    {isCurrent && (
                      <Badge variant="secondary">
                        <Check className="size-3" /> Current
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {formatPrice(plan.priceCents)}
                    {plan.priceCents > 0 ? `/${plan.interval}` : ''} ·{' '}
                    {plan.entitlements.maxStaff} staff
                  </p>
                </div>
                {plan.priceCents > 0 && !isCurrent && (
                  <Button
                    disabled={busyAction !== null}
                    onClick={() =>
                      post(
                        { action: 'checkout', planId: plan.id },
                        `checkout:${plan.id}`,
                      )
                    }
                  >
                    {busyAction === `checkout:${plan.id}` && (
                      <Loader2 className="size-4 animate-spin" />
                    )}
                    Choose {plan.label}
                  </Button>
                )}
              </Card>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
