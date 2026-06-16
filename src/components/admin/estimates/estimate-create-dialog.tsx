'use client';

import { useState } from 'react';
import { Plus, Trash2, Copy, Check } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { parseDollarsToCents } from '@/lib/admin/money-format';

interface LineItemDraft {
  readonly name: string;
  readonly quantity: string;
  readonly unitPrice: string; // dollars
}

interface OptionDraft {
  readonly name: string;
  readonly lineItems: LineItemDraft[];
}

interface EstimateCreateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Pre-fill the link to a request/customer when launched from their detail. */
  readonly serviceRequestId?: string;
  readonly customerId?: string;
  readonly onCreated?: () => void;
}

function emptyOption(name: string): OptionDraft {
  return { name, lineItems: [{ name: '', quantity: '1', unitPrice: '' }] };
}

export function EstimateCreateDialog({
  open,
  onOpenChange,
  serviceRequestId,
  customerId,
  onCreated,
}: EstimateCreateDialogProps) {
  const [options, setOptions] = useState<OptionDraft[]>([emptyOption('Good')]);
  const [expiresInDays, setExpiresInDays] = useState('30');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  function reset(): void {
    setOptions([emptyOption('Good')]);
    setExpiresInDays('30');
    setError(null);
    setApprovalUrl(null);
    setCopied(false);
  }

  function updateOption(i: number, patch: Partial<OptionDraft>): void {
    setOptions((prev) => prev.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  }

  function updateLine(oi: number, li: number, patch: Partial<LineItemDraft>): void {
    setOptions((prev) =>
      prev.map((o, idx) =>
        idx === oi
          ? {
              ...o,
              lineItems: o.lineItems.map((l, j) =>
                j === li ? { ...l, ...patch } : l,
              ),
            }
          : o,
      ),
    );
  }

  function addOption(): void {
    const names = ['Good', 'Better', 'Best'];
    const next = names[options.length] ?? `Option ${options.length + 1}`;
    setOptions((prev) => [...prev, emptyOption(next)]);
  }

  function removeOption(i: number): void {
    setOptions((prev) => prev.filter((_, idx) => idx !== i));
  }

  function addLine(oi: number): void {
    setOptions((prev) =>
      prev.map((o, idx) =>
        idx === oi
          ? { ...o, lineItems: [...o.lineItems, { name: '', quantity: '1', unitPrice: '' }] }
          : o,
      ),
    );
  }

  function removeLine(oi: number, li: number): void {
    setOptions((prev) =>
      prev.map((o, idx) =>
        idx === oi
          ? { ...o, lineItems: o.lineItems.filter((_, j) => j !== li) }
          : o,
      ),
    );
  }

  async function handleSubmit(): Promise<void> {
    setError(null);
    const payloadOptions = options.map((o) => ({
      name: o.name.trim(),
      lineItems: o.lineItems
        .filter((l) => l.name.trim())
        .map((l) => ({
          name: l.name.trim(),
          quantity: Math.max(1, parseInt(l.quantity, 10) || 1),
          unitPriceCents: parseDollarsToCents(l.unitPrice),
        })),
    }));

    if (payloadOptions.some((o) => !o.name || o.lineItems.length === 0)) {
      setError('Each option needs a name and at least one line item.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/admin/estimates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serviceRequestId,
          customerId,
          expiresInDays: parseInt(expiresInDays, 10) || undefined,
          options: payloadOptions,
        }),
      });
      const body = await res.json().catch(() => ({ success: false }));
      if (res.ok && body.success) {
        setApprovalUrl(body.data.approvalUrl as string);
        onCreated?.();
      } else {
        setError(body.error?.message ?? 'Failed to create estimate.');
      }
    } catch {
      setError('Could not connect to the server.');
    } finally {
      setIsSubmitting(false);
    }
  }

  async function copyLink(): Promise<void> {
    if (!approvalUrl) return;
    try {
      await navigator.clipboard.writeText(approvalUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be blocked; the link is still visible to copy manually.
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New estimate</DialogTitle>
          <DialogDescription>
            Build good / better / best options. Tax is applied from your default
            rate.
          </DialogDescription>
        </DialogHeader>

        {approvalUrl ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Estimate created. Share this link with the customer to approve:
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={approvalUrl} className="font-mono text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={copyLink}>
                {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {options.map((opt, oi) => (
              <div key={oi} className="rounded-lg border p-3 space-y-3">
                <div className="flex items-center gap-2">
                  <Input
                    value={opt.name}
                    onChange={(e) => updateOption(oi, { name: e.target.value })}
                    placeholder="Option name (e.g. Good)"
                    className="font-medium"
                  />
                  {options.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => removeOption(oi)}
                      aria-label="Remove option"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  )}
                </div>

                <div className="space-y-2">
                  {opt.lineItems.map((line, li) => (
                    <div key={li} className="flex items-center gap-2">
                      <Input
                        value={line.name}
                        onChange={(e) => updateLine(oi, li, { name: e.target.value })}
                        placeholder="Line item"
                        className="flex-1"
                      />
                      <Input
                        value={line.quantity}
                        onChange={(e) =>
                          updateLine(oi, li, { quantity: e.target.value })
                        }
                        type="number"
                        min="1"
                        aria-label="Quantity"
                        className="w-16"
                      />
                      <Input
                        value={line.unitPrice}
                        onChange={(e) =>
                          updateLine(oi, li, { unitPrice: e.target.value })
                        }
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        aria-label="Unit price (dollars)"
                        className="w-24"
                      />
                      {opt.lineItems.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => removeLine(oi, li)}
                          aria-label="Remove line item"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => addLine(oi)}
                  >
                    <Plus className="mr-1 size-3" />
                    Add line item
                  </Button>
                </div>
              </div>
            ))}

            {options.length < 10 && (
              <Button type="button" variant="outline" size="sm" onClick={addOption}>
                <Plus className="mr-1 size-3" />
                Add option
              </Button>
            )}

            <div className="space-y-2">
              <Label htmlFor="expires">Expires in (days)</Label>
              <Input
                id="expires"
                type="number"
                min="1"
                max="365"
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                className="w-32"
              />
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {approvalUrl ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={isSubmitting}>
                {isSubmitting ? 'Creating…' : 'Create estimate'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
