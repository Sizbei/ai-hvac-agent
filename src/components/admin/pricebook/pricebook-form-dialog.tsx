'use client';

import { useState, useEffect } from 'react';
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
import {
  formatCentsExact,
  parseDollarsToCents,
} from '@/lib/admin/money-format';
import type { PricebookItem } from '@/hooks/use-pricebook';

interface PricebookFormDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
  /** Non-null when editing an existing item; null when creating. */
  readonly editing: PricebookItem | null;
}

type ItemType = 'service' | 'material' | 'equipment';

interface FormState {
  readonly type: ItemType;
  readonly name: string;
  readonly sku: string;
  readonly description: string;
  /** Dollars (string) — converted to cents on submit. */
  readonly price: string;
  readonly memberPrice: string;
  readonly cost: string;
  readonly markupPct: string;
  readonly hours: string;
  readonly warranty: string;
}

const INITIAL_FORM: FormState = {
  type: 'service',
  name: '',
  sku: '',
  description: '',
  price: '',
  memberPrice: '',
  cost: '',
  markupPct: '',
  hours: '',
  warranty: '',
};

/** Cents -> a plain dollar string for editing (no $ / thousands separators). */
function centsToDollarInput(cents: number | null): string {
  if (cents == null) return '';
  return (cents / 100).toFixed(2);
}

function createFormState(item: PricebookItem | null): FormState {
  if (!item) return INITIAL_FORM;
  return {
    type: item.type as ItemType,
    name: item.name,
    sku: item.sku ?? '',
    description: item.description ?? '',
    price: centsToDollarInput(item.priceCents),
    memberPrice: centsToDollarInput(item.memberPriceCents),
    cost: centsToDollarInput(item.costCents),
    markupPct: item.markupPct ? String(item.markupPct) : '',
    hours: item.hours != null ? String(item.hours) : '',
    warranty: item.warranty ?? '',
  };
}

export function PricebookFormDialog({
  open,
  onClose,
  onSuccess,
  editing,
}: PricebookFormDialogProps) {
  const isEditMode = editing !== null;
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  function validate(): string | null {
    if (!form.name.trim()) return 'Name is required';
    if (!form.price.trim() || parseDollarsToCents(form.price) < 0) {
      return 'A valid price is required';
    }
    return null;
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const payload = {
        type: form.type,
        name: form.name.trim(),
        sku: form.sku.trim() || undefined,
        description: form.description.trim() || undefined,
        priceCents: parseDollarsToCents(form.price),
        memberPriceCents: form.memberPrice.trim()
          ? parseDollarsToCents(form.memberPrice)
          : null,
        costCents: form.cost.trim() ? parseDollarsToCents(form.cost) : 0,
        markupPct: form.markupPct.trim() ? parseInt(form.markupPct, 10) : 0,
        hours: form.hours.trim() ? parseInt(form.hours, 10) : null,
        warranty: form.warranty.trim() || undefined,
      };

      const url =
        isEditMode && editing
          ? `/api/admin/pricebook/${editing.id}`
          : '/api/admin/pricebook';
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
        setError(body?.error?.message ?? 'Failed to save item');
        return;
      }

      onSuccess();
      onClose();
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Item' : 'Add Item'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Update this pricebook item.'
              : 'Create a new pricebook item.'}
          </DialogDescription>
        </DialogHeader>

        {editing?.fieldpulseItemId && (
          <p className="text-xs text-muted-foreground rounded-md border border-border bg-muted/40 px-3 py-2">
            Synced from FieldPulse — cost, markup, and description are refreshed
            nightly from FieldPulse and will overwrite any edits made here.
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="item-type">Type</Label>
              <Select
                value={form.type}
                onValueChange={(v) =>
                  updateField('type', (v ?? 'service') as ItemType)
                }
              >
                <SelectTrigger id="item-type">
                  <SelectValue placeholder="Select a type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="service">Service</SelectItem>
                  <SelectItem value="material">Material</SelectItem>
                  <SelectItem value="equipment">Equipment</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="item-sku">SKU</Label>
              <Input
                id="item-sku"
                value={form.sku}
                onChange={(e) => updateField('sku', e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="item-name">Name</Label>
            <Input
              id="item-name"
              value={form.name}
              onChange={(e) => updateField('name', e.target.value)}
              placeholder="Item name"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="item-description">Description</Label>
            <Input
              id="item-description"
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="item-price">Price (USD)</Label>
              <Input
                id="item-price"
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
              <Label htmlFor="item-member-price">Member Price (USD)</Label>
              <Input
                id="item-member-price"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={form.memberPrice}
                onChange={(e) => updateField('memberPrice', e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label htmlFor="item-cost">Cost (USD)</Label>
              <Input
                id="item-cost"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={form.cost}
                onChange={(e) => updateField('cost', e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="item-markup">Markup %</Label>
              <Input
                id="item-markup"
                type="number"
                min="0"
                step="1"
                value={form.markupPct}
                onChange={(e) => updateField('markupPct', e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="item-hours">Labor hrs</Label>
              <Input
                id="item-hours"
                type="number"
                min="0"
                step="1"
                value={form.hours}
                onChange={(e) => updateField('hours', e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="item-warranty">Warranty</Label>
            <Input
              id="item-warranty"
              value={form.warranty}
              onChange={(e) => updateField('warranty', e.target.value)}
              placeholder="Optional (e.g. 1 year parts & labor)"
            />
          </div>

          {form.price.trim() && (
            <p className="text-xs text-muted-foreground">
              Price will be stored as{' '}
              {formatCentsExact(parseDollarsToCents(form.price))}.
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
