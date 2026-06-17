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
import { parseDollarsToCents } from '@/lib/admin/money-format';
import type { InventoryItem } from '@/hooks/use-inventory';

/** A pricebook material the inventory row links to. */
export interface MaterialOption {
  readonly id: string;
  readonly name: string;
}

interface InventoryFormDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
  /** Non-null when editing an existing tracked item; null when adding. */
  readonly editing: InventoryItem | null;
  /** Pricebook materials available to track (shown only when adding). */
  readonly materials: readonly MaterialOption[];
}

interface FormState {
  readonly pricebookItemId: string;
  readonly quantityOnHand: string;
  readonly reorderPoint: string;
  /** Unit cost in dollars (string) — converted to cents on submit. */
  readonly unitCost: string;
  readonly location: string;
}

const INITIAL: FormState = {
  pricebookItemId: '',
  quantityOnHand: '0',
  reorderPoint: '',
  unitCost: '',
  location: '',
};

function createFormState(item: InventoryItem | null): FormState {
  if (!item) return INITIAL;
  return {
    pricebookItemId: item.pricebookItemId,
    quantityOnHand: String(item.quantityOnHand),
    reorderPoint: item.reorderPoint != null ? String(item.reorderPoint) : '',
    unitCost: (item.unitCostCents / 100).toFixed(2),
    location: item.location ?? '',
  };
}

export function InventoryFormDialog({
  open,
  onClose,
  onSuccess,
  editing,
  materials,
}: InventoryFormDialogProps) {
  const isEditMode = editing !== null;
  const [form, setForm] = useState<FormState>(INITIAL);
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

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!form.pricebookItemId) {
      setError('Select a material');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const payload = {
        pricebookItemId: form.pricebookItemId,
        quantityOnHand: form.quantityOnHand.trim()
          ? parseInt(form.quantityOnHand, 10)
          : 0,
        reorderPoint: form.reorderPoint.trim()
          ? parseInt(form.reorderPoint, 10)
          : null,
        unitCostCents: form.unitCost.trim()
          ? parseDollarsToCents(form.unitCost)
          : 0,
        location: form.location.trim() || null,
      };

      const res = await fetch('/api/admin/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'An unexpected error occurred' },
        }));
        setError(body?.error?.message ?? 'Failed to save stock');
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
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEditMode ? 'Edit Stock' : 'Track Material'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? `Update on-hand stock and reorder point for ${editing?.itemName}.`
              : 'Start tracking a pricebook material in inventory.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isEditMode && (
            <div className="space-y-2">
              <Label htmlFor="inv-material">Material</Label>
              <Select
                value={form.pricebookItemId}
                onValueChange={(v) => updateField('pricebookItemId', v ?? '')}
              >
                <SelectTrigger id="inv-material">
                  <SelectValue placeholder="Select a material" />
                </SelectTrigger>
                <SelectContent>
                  {materials.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="inv-qty">On Hand</Label>
              <Input
                id="inv-qty"
                type="number"
                min="0"
                step="1"
                value={form.quantityOnHand}
                onChange={(e) => updateField('quantityOnHand', e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-reorder">Reorder At</Label>
              <Input
                id="inv-reorder"
                type="number"
                min="0"
                step="1"
                value={form.reorderPoint}
                onChange={(e) => updateField('reorderPoint', e.target.value)}
                placeholder="Optional"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="inv-cost">Unit Cost (USD)</Label>
              <Input
                id="inv-cost"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
                value={form.unitCost}
                onChange={(e) => updateField('unitCost', e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inv-location">Location</Label>
              <Input
                id="inv-location"
                value={form.location}
                onChange={(e) => updateField('location', e.target.value)}
                placeholder="Optional (e.g. Truck 2)"
              />
            </div>
          </div>

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
