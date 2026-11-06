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
import { selectLabel } from '@/lib/admin/select-label';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { parseMoneyInput } from '@/lib/admin/money-format';
import type { InventoryItem } from '@/hooks/use-inventory';

/** A pricebook material the inventory row links to. */
export interface MaterialOption {
  readonly id: string;
  readonly name: string;
  /** Pricebook cost — pre-fills the unit cost when the material is picked. */
  readonly costCents?: number;
}

interface InventoryFormDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
  /** Non-null when editing an existing tracked item; null when adding. */
  readonly editing: InventoryItem | null;
  /**
   * Pricebook materials available to track (shown only when adding). The
   * caller leaves out materials that are already tracked.
   */
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

    let unitCostCents: number | null = null;
    if (form.unitCost.trim()) {
      const cost = parseMoneyInput(form.unitCost);
      if (!cost.ok) {
        setError(cost.error);
        return;
      }
      unitCostCents = cost.cents;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const payload = isEditMode
        ? {
            pricebookItemId: form.pricebookItemId,
            update: true,
            quantityOnHand: form.quantityOnHand.trim()
              ? parseInt(form.quantityOnHand, 10)
              : 0,
            reorderPoint: form.reorderPoint.trim()
              ? parseInt(form.reorderPoint, 10)
              : null,
            unitCostCents: unitCostCents ?? 0,
            location: form.location.trim() || null,
          }
        : // Adding: send only what was filled in. The server inserts and
          // refuses (409) a material that is already tracked.
          {
            pricebookItemId: form.pricebookItemId,
            ...(form.quantityOnHand.trim()
              ? { quantityOnHand: parseInt(form.quantityOnHand, 10) }
              : {}),
            ...(form.reorderPoint.trim()
              ? { reorderPoint: parseInt(form.reorderPoint, 10) }
              : {}),
            ...(unitCostCents !== null ? { unitCostCents } : {}),
            ...(form.location.trim() ? { location: form.location.trim() } : {}),
          };

      const res = await fetch('/api/admin/inventory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: null,
        }));
        setError(
          body?.error?.code === 'ALREADY_TRACKED'
            ? 'This material is already tracked. Edit its row in the list instead.'
            : "Couldn't save the stock. Please try again.",
        );
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
          <DialogTitle>{isEditMode ? 'Edit stock' : 'Track material'}</DialogTitle>
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
                onValueChange={(v) => {
                  const id = v ?? '';
                  const cost = materials.find((m) => m.id === id)?.costCents;
                  setForm((prev) => ({
                    ...prev,
                    pricebookItemId: id,
                    // Pre-fill from the pricebook unless a cost was typed already.
                    unitCost:
                      !prev.unitCost.trim() && cost != null && cost > 0
                        ? (cost / 100).toFixed(2)
                        : prev.unitCost,
                  }));
                }}
              >
                <SelectTrigger id="inv-material">
                  <SelectValue>
                    {(v: unknown) =>
                      selectLabel(
                        materials.map((m) => ({ value: m.id, label: m.name })),
                        v,
                        'Select a material',
                      )
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {materials.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {materials.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Every active pricebook material is already tracked. Add a
                  material to the pricebook first, or edit an existing row.
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="inv-qty">On hand</Label>
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
              <Label htmlFor="inv-reorder">Reorder at</Label>
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
              <Label htmlFor="inv-cost">Unit cost (USD)</Label>
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
              {isSubmitting ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
