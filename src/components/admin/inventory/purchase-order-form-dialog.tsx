'use client';

import { useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';
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
import type { InventoryItem } from '@/hooks/use-inventory';
import type { MaterialOption } from './inventory-form-dialog';

interface PurchaseOrderFormDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSuccess: () => void;
  readonly materials: readonly MaterialOption[];
  readonly inventory: readonly InventoryItem[];
}

interface LineDraft {
  readonly pricebookItemId: string;
  readonly quantity: string;
  /** Unit cost in dollars (string). */
  readonly unitCost: string;
}

const EMPTY_LINE: LineDraft = { pricebookItemId: '', quantity: '1', unitCost: '' };

export function PurchaseOrderFormDialog({
  open,
  onClose,
  onSuccess,
  materials,
  inventory,
}: PurchaseOrderFormDialogProps) {
  const [vendorName, setVendorName] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([EMPTY_LINE]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setVendorName('');
      setLines([EMPTY_LINE]);
      setError(null);
    }
  }, [open]);

  function updateLine(index: number, patch: Partial<LineDraft>): void {
    setLines((prev) =>
      prev.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    );
  }

  function onMaterialChange(index: number, pricebookItemId: string): void {
    // Default the unit cost to the tracked latest cost when known.
    const tracked = inventory.find((i) => i.pricebookItemId === pricebookItemId);
    updateLine(index, {
      pricebookItemId,
      unitCost:
        tracked && tracked.unitCostCents > 0
          ? (tracked.unitCostCents / 100).toFixed(2)
          : lines[index]?.unitCost ?? '',
    });
  }

  function addLine(): void {
    setLines((prev) => [...prev, EMPTY_LINE]);
  }

  function removeLine(index: number): void {
    setLines((prev) =>
      prev.length === 1 ? prev : prev.filter((_, i) => i !== index),
    );
  }

  const total = lines.reduce((sum, l) => {
    const qty = parseInt(l.quantity, 10);
    const cost = parseDollarsToCents(l.unitCost);
    return sum + (Number.isFinite(qty) ? qty : 0) * cost;
  }, 0);

  function nameFor(pricebookItemId: string): string {
    return materials.find((m) => m.id === pricebookItemId)?.name ?? '';
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!vendorName.trim()) {
      setError('Vendor name is required');
      return;
    }
    const validLines = lines.filter(
      (l) => l.pricebookItemId && parseInt(l.quantity, 10) > 0,
    );
    if (validLines.length === 0) {
      setError('Add at least one line with a material and quantity');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const payload = {
        vendorName: vendorName.trim(),
        lines: validLines.map((l) => ({
          pricebookItemId: l.pricebookItemId,
          description: nameFor(l.pricebookItemId),
          quantity: parseInt(l.quantity, 10),
          unitCostCents: parseDollarsToCents(l.unitCost),
        })),
      };

      const res = await fetch('/api/admin/inventory/purchase-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'An unexpected error occurred' },
        }));
        setError(body?.error?.message ?? 'Failed to create purchase order');
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Purchase Order</DialogTitle>
          <DialogDescription>
            Order materials from a vendor. The PO starts as a draft.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="po-vendor">Vendor</Label>
            <Input
              id="po-vendor"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              placeholder="Vendor name"
              required
            />
          </div>

          <div className="space-y-3">
            <Label>Lines</Label>
            {lines.map((line, index) => (
              <div key={index} className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <Select
                    value={line.pricebookItemId}
                    onValueChange={(v) => onMaterialChange(index, v ?? '')}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Material" />
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
                <div className="w-20 space-y-1">
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={line.quantity}
                    onChange={(e) => updateLine(index, { quantity: e.target.value })}
                    aria-label="Quantity"
                  />
                </div>
                <div className="w-28 space-y-1">
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    inputMode="decimal"
                    value={line.unitCost}
                    onChange={(e) => updateLine(index, { unitCost: e.target.value })}
                    placeholder="Unit $"
                    aria-label="Unit cost"
                  />
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeLine(index)}
                  disabled={lines.length === 1}
                  aria-label="Remove line"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={addLine}>
              <Plus className="mr-2 h-4 w-4" />
              Add Line
            </Button>
          </div>

          <p className="text-right text-sm text-muted-foreground">
            Total: <span className="tabular-nums">{formatCentsExact(total)}</span>
          </p>

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
              {isSubmitting ? 'Creating...' : 'Create PO'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
