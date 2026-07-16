'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { formatCentsExact, parseDollarsToCents } from '@/lib/admin/money-format';
import type { MembershipPlan } from '@/hooks/use-membership-plans';

interface MembershipPlanFormDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
  /** Non-null when editing; null when creating. */
  readonly editing: MembershipPlan | null;
}

type BillingPeriod = 'monthly' | 'annual';

interface FormState {
  readonly name: string;
  readonly description: string;
  /** Dollars (string) — converted to cents on submit. */
  readonly price: string;
  readonly billingPeriod: BillingPeriod;
  /** Maintenance visits owed per year (string for the input; 0 = billing-only). */
  readonly visitsPerYear: string;
}

const INITIAL_FORM: FormState = {
  name: '',
  description: '',
  price: '',
  billingPeriod: 'monthly',
  visitsPerYear: '0',
};

function createFormState(plan: MembershipPlan | null): FormState {
  if (!plan) return INITIAL_FORM;
  return {
    name: plan.name,
    description: plan.description ?? '',
    price: (plan.priceCents / 100).toFixed(2),
    billingPeriod: plan.billingPeriod as BillingPeriod,
    visitsPerYear: String(plan.visitsPerYear ?? 0),
  };
}

export function MembershipPlanFormDialog({
  open,
  onClose,
  onSuccess,
  editing,
}: MembershipPlanFormDialogProps) {
  const isEditMode = editing !== null;
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setForm(createFormState(editing));
      setError(null);
    }
  }, [open, editing]);

  function updateField<K extends keyof FormState>(
    field: K,
    value: FormState[K],
  ): void {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    if (!form.price.trim() || parseDollarsToCents(form.price) < 0) {
      setError('A valid price is required');
      return;
    }
    if (submittingRef.current) return;
    submittingRef.current = true;

    setIsSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        priceCents: parseDollarsToCents(form.price),
        billingPeriod: form.billingPeriod,
        visitsPerYear: Number.parseInt(form.visitsPerYear, 10) || 0,
      };
      const url =
        isEditMode && editing
          ? `/api/admin/membership-plans/${editing.id}`
          : '/api/admin/membership-plans';
      const method = isEditMode ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'An unexpected error occurred' },
        }));
        setError(body?.error?.message ?? 'Failed to save plan');
        return;
      }
      onSuccess();
      onClose();
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      setIsSubmitting(false);
      submittingRef.current = false;
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen && submittingRef.current) return; if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Plan' : 'Add Plan'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Update this membership plan.'
              : 'Create a recurring membership plan.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="plan-name">Name</Label>
            <Input
              id="plan-name"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="e.g. Comfort Club"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="plan-description">Description</Label>
            <Input
              id="plan-description"
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              placeholder="Optional (e.g. 2 tune-ups/year + 15% off repairs)"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="plan-price">Price (USD)</Label>
              <Input
                id="plan-price"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={form.price}
                onChange={(e) => updateField('price', e.target.value)}
                placeholder="0.00"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="plan-billing">Billing</Label>
              <Select
                value={form.billingPeriod}
                onValueChange={(v) =>
                  updateField('billingPeriod', (v ?? 'monthly') as BillingPeriod)
                }
              >
                <SelectTrigger id="plan-billing">
                  <SelectValue placeholder="Select" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="annual">Annual</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="plan-visits">Maintenance visits / year</Label>
            <Input
              id="plan-visits"
              type="number"
              step="1"
              min="0"
              max="12"
              inputMode="numeric"
              value={form.visitsPerYear}
              onChange={(e) => updateField('visitsPerYear', e.target.value)}
              placeholder="0"
            />
            <p className="text-xs text-muted-foreground">
              Scheduled tune-ups members get automatically. 0 = billing-only (no
              auto-generated visits).
            </p>
          </div>

          {form.price.trim() && (
            <p className="text-xs text-muted-foreground">
              Charged {formatCentsExact(parseDollarsToCents(form.price))} per{' '}
              {form.billingPeriod === 'annual' ? 'year' : 'month'}.
            </p>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
