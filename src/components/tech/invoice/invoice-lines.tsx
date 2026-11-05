'use client';

import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatCentsExact } from '@/lib/admin/money-format';
import { taxLabel, totalsFooter } from '@/lib/tech/invoice-page-copy';
import type { TechInvoice, TechUnbilledMaterial } from '@/lib/tech/invoice-view';

const MONEY = 'font-mono tabular-nums';

/** Invoice lines (`name · qty × unit · total`); a 44 px remove control per row when `onRemove` is given. */
export function InvoiceLines({
  invoice,
  onRemove,
  disabled = false,
}: {
  readonly invoice: TechInvoice;
  readonly onRemove?: (lineId: string) => void;
  readonly disabled?: boolean;
}) {
  if (invoice.lines.length === 0) {
    return <p className="py-2 text-[15px] text-muted-foreground">No items yet.</p>;
  }
  return (
    <ul className="divide-y divide-border" aria-label="Invoice items">
      {invoice.lines.map((l) => (
        <li key={l.id} className="flex min-h-14 items-center gap-2 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-[15px] leading-5 font-medium break-words">{l.name}</p>
            <p className={`${MONEY} text-[13px] text-muted-foreground`}>
              {l.quantity} × {formatCentsExact(l.unitPriceCents)}
            </p>
          </div>
          <span className={`${MONEY} shrink-0 text-[15px]`}>{formatCentsExact(l.lineTotalCents)}</span>
          {onRemove && (
            <Button
              variant="ghost"
              className="size-11 shrink-0 rounded-xl text-muted-foreground"
              aria-label={`Remove ${l.name}`}
              disabled={disabled}
              onClick={() => onRemove(l.id)}
            >
              <X className="size-5" />
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Job materials not yet on the draft, each with an "Add" control. */
export function UnbilledMaterials({
  materials,
  onAdd,
  disabled = false,
}: {
  readonly materials: readonly TechUnbilledMaterial[];
  readonly onAdd?: (materialId: string) => void;
  readonly disabled?: boolean;
}) {
  if (materials.length === 0) return null;
  return (
    <section aria-labelledby="unbilled-title" className="space-y-1">
      <h3 id="unbilled-title" className="text-[13px] font-semibold text-muted-foreground">
        Materials not on this invoice
      </h3>
      <ul className="divide-y divide-border">
        {materials.map((m) => (
          <li key={m.id} className="flex min-h-14 items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-[15px] leading-5 break-words">{m.name}</p>
              <p className={`${MONEY} text-[13px] text-muted-foreground`}>
                {m.quantity} × {formatCentsExact(m.unitPriceCents)}
              </p>
            </div>
            {onAdd && (
              <Button
                variant="outline"
                className="h-11 shrink-0 rounded-xl px-4 text-[15px]"
                disabled={disabled}
                onClick={() => onAdd(m.id)}
              >
                Add
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ label, cents, strong = false }: { label: string; cents: number; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? 'text-[17px] font-semibold' : 'text-[15px]'}`}>
      <span className={strong ? '' : 'text-muted-foreground'}>{label}</span>
      <span className={MONEY}>{formatCentsExact(cents)}</span>
    </div>
  );
}

/** Subtotal, tax (with the rate while draft), total; then paid so far and a state-keyed footer once finalized. */
export function InvoiceTotals({ invoice }: { readonly invoice: TechInvoice }) {
  const footer = totalsFooter(invoice.state, invoice.totalCents, invoice.balanceCents);
  return (
    <div className="space-y-1.5 border-t pt-3">
      <Row label="Subtotal" cents={invoice.subtotalCents} />
      <Row label={taxLabel(invoice.taxBps)} cents={invoice.taxCents} />
      <Row label="Total" cents={invoice.totalCents} strong />
      {footer && invoice.amountPaidCents > 0 && <Row label="Paid so far" cents={invoice.amountPaidCents} />}
      {footer?.kind === 'balance' && <Row label={footer.label} cents={footer.cents} strong />}
      {footer?.kind === 'paid' && <p className="text-right text-[15px] font-semibold text-success-strong">{footer.label}</p>}
      {footer?.kind === 'note' && <p className="text-right text-[15px] font-semibold text-muted-foreground">{footer.label}</p>}
    </div>
  );
}
