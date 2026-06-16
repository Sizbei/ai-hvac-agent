'use client';

import { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TaxRate } from '@/hooks/use-pricebook';

interface TaxRatesPanelProps {
  readonly taxRates: readonly TaxRate[];
  readonly isLoading: boolean;
  readonly onChanged: () => void;
}

/** Basis points -> "8.25%". */
function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

interface DialogState {
  readonly name: string;
  readonly jurisdiction: string;
  /** Percent string (e.g. "8.25") — converted to bps on submit. */
  readonly ratePct: string;
  readonly isDefault: boolean;
}

const INITIAL_DIALOG: DialogState = {
  name: '',
  jurisdiction: '',
  ratePct: '',
  isDefault: false,
};

export function TaxRatesPanel({
  taxRates,
  isLoading,
  onChanged,
}: TaxRatesPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TaxRate | null>(null);
  const [form, setForm] = useState<DialogState>(INITIAL_DIALOG);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (dialogOpen) {
      setForm(
        editing
          ? {
              name: editing.name,
              jurisdiction: editing.jurisdiction ?? '',
              ratePct: (editing.rateBps / 100).toFixed(2),
              isDefault: editing.isDefault,
            }
          : INITIAL_DIALOG,
      );
      setError(null);
    }
  }, [dialogOpen, editing]);

  function openAdd(): void {
    setEditing(null);
    setDialogOpen(true);
  }

  function openEdit(rate: TaxRate): void {
    setEditing(rate);
    setDialogOpen(true);
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    const rateBps = Math.round(parseFloat(form.ratePct) * 100);
    if (!Number.isFinite(rateBps) || rateBps < 0 || rateBps > 10000) {
      setError('Rate must be between 0% and 100%');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const payload = {
        name: form.name.trim(),
        jurisdiction: form.jurisdiction.trim() || undefined,
        rateBps,
        isDefault: form.isDefault,
      };
      const url = editing
        ? `/api/admin/pricebook/tax-rates/${editing.id}`
        : '/api/admin/pricebook/tax-rates';
      const method = editing ? 'PATCH' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({
          error: { message: 'An unexpected error occurred' },
        }));
        setError(body?.error?.message ?? 'Failed to save tax rate');
        return;
      }

      onChanged();
      setDialogOpen(false);
    } catch {
      setError('Could not connect to server. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleSetDefault(rate: TaxRate): Promise<void> {
    if (rate.isDefault) return;
    const res = await fetch(`/api/admin/pricebook/tax-rates/${rate.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isDefault: true }),
    });
    if (res.ok) onChanged();
  }

  async function handleDeactivate(rate: TaxRate): Promise<void> {
    const res = await fetch(`/api/admin/pricebook/tax-rates/${rate.id}`, {
      method: 'DELETE',
    });
    if (res.ok) onChanged();
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Tax Rates</h2>
          <p className="text-sm text-muted-foreground">
            Jurisdictional tax rates. One rate can be the org default.
          </p>
        </div>
        <Button variant="outline" onClick={openAdd}>
          <Plus className="mr-2 h-4 w-4" />
          Add Rate
        </Button>
      </div>

      {!isLoading && taxRates.length === 0 ? (
        <div className="py-8 text-center text-muted-foreground">
          No tax rates configured.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Jurisdiction</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead>Default</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {taxRates.map((rate) => (
              <TableRow key={rate.id}>
                <TableCell className="font-medium">{rate.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {rate.jurisdiction ?? '—'}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatBps(rate.rateBps)}
                </TableCell>
                <TableCell>
                  {rate.isDefault ? (
                    <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                      Default
                    </Badge>
                  ) : (
                    <Switch
                      checked={false}
                      onCheckedChange={() => void handleSetDefault(rate)}
                      aria-label={`Make ${rate.name} the default tax rate`}
                    />
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openEdit(rate)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleDeactivate(rate)}
                    >
                      Remove
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => { if (!open) setDialogOpen(false); }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Edit Tax Rate' : 'Add Tax Rate'}
            </DialogTitle>
            <DialogDescription>
              Enter the rate as a percentage (e.g. 8.25 for 8.25%).
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tax-name">Name</Label>
              <Input
                id="tax-name"
                value={form.name}
                onChange={(e) =>
                  setForm((p) => ({ ...p, name: e.target.value }))
                }
                placeholder="e.g. State Sales Tax"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tax-jurisdiction">Jurisdiction</Label>
              <Input
                id="tax-jurisdiction"
                value={form.jurisdiction}
                onChange={(e) =>
                  setForm((p) => ({ ...p, jurisdiction: e.target.value }))
                }
                placeholder="Optional (e.g. TN)"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="tax-rate">Rate (%)</Label>
              <Input
                id="tax-rate"
                type="number"
                step="0.01"
                min="0"
                max="100"
                inputMode="decimal"
                value={form.ratePct}
                onChange={(e) =>
                  setForm((p) => ({ ...p, ratePct: e.target.value }))
                }
                placeholder="8.25"
                required
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="tax-default">Set as default</Label>
              <Switch
                id="tax-default"
                checked={form.isDefault}
                onCheckedChange={(checked) =>
                  setForm((p) => ({ ...p, isDefault: checked }))
                }
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDialogOpen(false)}
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
    </section>
  );
}
