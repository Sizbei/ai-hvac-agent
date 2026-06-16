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
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { parseDollarsToCents, formatCentsExact } from '@/lib/admin/money-format';
import { usePricebook, type PricebookItem } from '@/hooks/use-pricebook';

const MANUAL = '__manual__';

interface LineItemDraft {
  /** "" when picked from catalog (name comes from the item). */
  readonly name: string;
  readonly quantity: string;
  readonly unitPrice: string; // dollars (manual lines only)
  /** Set when the line is a catalog pick; null for a manual line. */
  readonly pricebookItemId: string | null;
  readonly useMemberPrice: boolean;
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

function emptyLine(): LineItemDraft {
  return {
    name: '',
    quantity: '1',
    unitPrice: '',
    pricebookItemId: null,
    useMemberPrice: false,
  };
}

function emptyOption(name: string): OptionDraft {
  return { name, lineItems: [emptyLine()] };
}

/** Catalog unit price for a picked item, honoring the member-price toggle. */
function catalogUnitCents(item: PricebookItem, useMember: boolean): number {
  return useMember && item.memberPriceCents != null
    ? item.memberPriceCents
    : item.priceCents;
}

export function EstimateCreateDialog({
  open,
  onOpenChange,
  serviceRequestId,
  customerId,
  onCreated,
}: EstimateCreateDialogProps) {
  const { items, isLoading: pricebookLoading } = usePricebook();
  const itemById = new Map(items.map((i) => [i.id, i]));

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

  /** Switch a line between a catalog pick and a manual entry. */
  function pickItem(oi: number, li: number, selected: string): void {
    if (selected === MANUAL) {
      updateLine(oi, li, {
        pricebookItemId: null,
        useMemberPrice: false,
        name: '',
        unitPrice: '',
      });
      return;
    }
    updateLine(oi, li, { pricebookItemId: selected, useMemberPrice: false });
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
        idx === oi ? { ...o, lineItems: [...o.lineItems, emptyLine()] } : o,
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
    // Build the payload. Catalog lines submit only pricebookItemId (+ qty +
    // member-price toggle) — the SERVER re-snapshots name/price/cost. Manual lines
    // submit name + price.
    const payloadOptions = options.map((o) => ({
      name: o.name.trim(),
      lineItems: o.lineItems
        .filter((l) => (l.pricebookItemId ? true : l.name.trim()))
        .map((l) =>
          l.pricebookItemId
            ? {
                pricebookItemId: l.pricebookItemId,
                quantity: Math.max(1, parseInt(l.quantity, 10) || 1),
                useMemberPrice: l.useMemberPrice,
              }
            : {
                name: l.name.trim(),
                quantity: Math.max(1, parseInt(l.quantity, 10) || 1),
                unitPriceCents: parseDollarsToCents(l.unitPrice),
              },
        ),
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

                <div className="space-y-3">
                  {opt.lineItems.map((line, li) => {
                    const item = line.pricebookItemId
                      ? itemById.get(line.pricebookItemId)
                      : undefined;
                    const hasMember = item?.memberPriceCents != null;
                    return (
                      <div
                        key={li}
                        className="space-y-2 rounded-md border border-dashed p-2"
                      >
                        <div className="flex items-center gap-2">
                          <Select
                            value={line.pricebookItemId ?? MANUAL}
                            onValueChange={(v) => pickItem(oi, li, v ?? MANUAL)}
                          >
                            <SelectTrigger className="flex-1">
                              <SelectValue
                                placeholder={
                                  pricebookLoading
                                    ? 'Loading catalog…'
                                    : 'Pick from pricebook or enter manually'
                                }
                              />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={MANUAL}>Manual entry</SelectItem>
                              {items.map((it) => (
                                <SelectItem key={it.id} value={it.id}>
                                  {it.name} — {formatCentsExact(it.priceCents)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
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

                        <div className="flex items-center gap-2">
                          {item ? (
                            // Catalog line: name + price are read-only (server-priced).
                            <div className="flex flex-1 items-center justify-between rounded-md bg-muted/40 px-2.5 py-1.5 text-sm">
                              <span className="truncate">{item.name}</span>
                              <span className="font-medium tabular-nums">
                                {formatCentsExact(
                                  catalogUnitCents(item, line.useMemberPrice),
                                )}
                              </span>
                            </div>
                          ) : (
                            // Manual line: free name + dollar price.
                            <>
                              <Input
                                value={line.name}
                                onChange={(e) =>
                                  updateLine(oi, li, { name: e.target.value })
                                }
                                placeholder="Line item"
                                className="flex-1"
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
                            </>
                          )}
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
                        </div>

                        {item && hasMember && (
                          <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Switch
                              checked={line.useMemberPrice}
                              onCheckedChange={(c) =>
                                updateLine(oi, li, { useMemberPrice: c })
                              }
                            />
                            Member price (
                            {formatCentsExact(item.memberPriceCents ?? 0)})
                          </label>
                        )}
                      </div>
                    );
                  })}
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
