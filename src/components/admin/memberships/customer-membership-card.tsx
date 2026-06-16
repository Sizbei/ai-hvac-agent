'use client';

import { useState, useEffect, useCallback } from 'react';
import { BadgeCheck } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { formatCentsExact } from '@/lib/admin/money-format';
import { useMembershipPlans } from '@/hooks/use-membership-plans';

interface ActiveMembership {
  readonly id: string;
  readonly planId: string;
  readonly status: string;
  readonly startedAt: string;
  readonly currentPeriodEnd: string | null;
  readonly plan: {
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
    readonly priceCents: number;
    readonly billingPeriod: string;
  };
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

interface CustomerMembershipCardProps {
  readonly customerId: string;
}

export function CustomerMembershipCard({
  customerId,
}: CustomerMembershipCardProps) {
  const { plans, isLoading: plansLoading } = useMembershipPlans();
  const [membership, setMembership] = useState<ActiveMembership | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedPlanId, setSelectedPlanId] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const fetchMembership = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch(`/api/admin/customers/${customerId}/membership`);
      if (!res.ok) {
        setError('Failed to load membership');
        return;
      }
      const body = (await res.json()) as {
        success: boolean;
        data: { membership: ActiveMembership | null };
      };
      if (body.success) setMembership(body.data.membership);
      setError(null);
    } catch {
      setError('Could not connect to server.');
    }
  }, [customerId]);

  useEffect(() => {
    setIsLoading(true);
    fetchMembership().finally(() => setIsLoading(false));
  }, [fetchMembership]);

  async function handleEnroll(): Promise<void> {
    if (!selectedPlanId) {
      setError('Pick a plan first.');
      return;
    }
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/customers/${customerId}/membership`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: selectedPlanId }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setSelectedPlanId('');
        await fetchMembership();
      } else {
        setError(body.error?.message ?? 'Failed to enroll.');
      }
    } catch {
      setError('Could not connect to server.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleCancel(): Promise<void> {
    setIsCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/admin/customers/${customerId}/membership`, {
        method: 'DELETE',
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setShowCancelConfirm(false);
        await fetchMembership();
      } else {
        setCancelError(body.error?.message ?? 'Failed to cancel.');
      }
    } catch {
      setCancelError('Could not connect to server.');
    } finally {
      setIsCancelling(false);
    }
  }

  const activePlans = plans.filter((p) => p.active);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BadgeCheck className="size-4" />
          Membership
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-12 w-full" />
        ) : membership ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{membership.plan.name}</p>
                {membership.plan.description && (
                  <p className="text-xs text-muted-foreground">
                    {membership.plan.description}
                  </p>
                )}
              </div>
              <Badge className="bg-green-100 capitalize text-green-800">
                {membership.status}
              </Badge>
            </div>
            <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              <span>
                {formatCentsExact(membership.plan.priceCents)} /{' '}
                {membership.plan.billingPeriod === 'annual' ? 'year' : 'month'}
              </span>
              <span>Member since {formatDate(membership.startedAt)}</span>
              {membership.currentPeriodEnd && (
                <span>
                  Current period ends {formatDate(membership.currentPeriodEnd)}
                </span>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCancelError(null);
                setShowCancelConfirm(true);
              }}
            >
              Cancel membership
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Not a member. Enroll this customer in a plan to apply member pricing.
            </p>
            {activePlans.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No active plans.{' '}
                <a href="/admin/membership-plans" className="underline">
                  Create one first.
                </a>
              </p>
            ) : (
              <div className="flex items-center gap-2">
                <Select
                  value={selectedPlanId}
                  onValueChange={(v) => setSelectedPlanId(v ?? '')}
                  disabled={plansLoading}
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue placeholder="Pick a plan" />
                  </SelectTrigger>
                  <SelectContent>
                    {activePlans.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name} — {formatCentsExact(p.priceCents)}/
                        {p.billingPeriod === 'annual' ? 'yr' : 'mo'}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={handleEnroll}
                  disabled={isSubmitting || !selectedPlanId}
                >
                  {isSubmitting ? 'Enrolling…' : 'Enroll'}
                </Button>
              </div>
            )}
          </div>
        )}

        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </CardContent>

      <ConfirmDialog
        open={showCancelConfirm}
        onOpenChange={setShowCancelConfirm}
        title="Cancel membership?"
        description="This ends the customer's active membership. Sent quotes keep their snapshotted member pricing; new quotes will use standard pricing."
        confirmLabel="Cancel membership"
        confirmingLabel="Cancelling..."
        isConfirming={isCancelling}
        error={cancelError}
        onConfirm={handleCancel}
      />
    </Card>
  );
}
