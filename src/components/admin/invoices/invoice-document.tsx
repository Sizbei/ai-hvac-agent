'use client';

import { Wind } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatCentsExact } from '@/lib/admin/money-format';
import type { InvoiceDetailView } from '@/lib/admin/invoice-queries';
import { invoiceDocModel } from './invoice-document-model';

export interface OrgIdentity {
  readonly companyName: string;
  readonly address: string | null;
  readonly phone: string | null;
}

interface Props {
  readonly invoice: InvoiceDetailView;
  readonly org: OrgIdentity;
}

function fmt(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Presentational "paper" invoice document. Calls invoiceDocModel for all
 * display logic; renders logo lockup, meta box, parties, line-item table,
 * notes, and totals. No data fetching or event handlers.
 */
export function InvoiceDocument({ invoice, org }: Props) {
  const m = invoiceDocModel(invoice);

  return (
    <div className="rounded-lg border bg-card shadow-sm">
      {/* ── paper body ── */}
      <div className="px-10 py-10 max-sm:px-6 max-sm:py-6">

        {/* ── top: logo lockup + meta box ── */}
        <div className="flex flex-wrap justify-between gap-8">
          {/* Logo + company address */}
          <div>
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-sm">
                <Wind className="size-5" />
              </span>
              <div className="leading-none">
                <p className="font-heading text-base font-bold tracking-tight text-foreground">
                  {org.companyName}
                </p>
              </div>
            </div>
            {(org.address || org.phone) && (
              <div className="mt-3 text-xs leading-relaxed text-muted-foreground">
                {org.address && <p>{org.address}</p>}
                {org.phone && <p>{org.phone}</p>}
              </div>
            )}
          </div>

          {/* Meta box */}
          <div className="min-w-[272px] overflow-hidden rounded-lg border">
            <MetaRow label="Invoice" value={m.invoiceRef} />
            {m.serviceDate && (
              <MetaRow label="Service date" value={fmt(m.serviceDate)} />
            )}
            <MetaRow label="Invoice date" value={fmt(m.invoiceDate)} />
            <MetaRow label="Due date" value={m.derivedNetTerms ? `${fmt(m.dueDate)} · Net 30` : fmt(m.dueDate)} />
            {/* Amount due — prominent row */}
            <div className="flex items-center justify-between gap-6 border-t-[1.5px] px-4 py-3">
              <span className="text-sm font-bold text-foreground">Amount due</span>
              <span
                className={cn(
                  'text-base font-bold tabular-nums',
                  m.isOverdue ? 'text-destructive' : 'text-foreground',
                )}
              >
                {formatCentsExact(m.amountDueCents)}
              </span>
            </div>
          </div>
        </div>

        {/* ── parties ── */}
        {(m.showTechnician || m.showServiceAddress) && (
          <div className="mt-8 flex flex-wrap justify-between gap-8">
            {m.showTechnician && (
              <div>
                <PartyLabel>Job performed by</PartyLabel>
                <p className="text-sm font-semibold text-foreground">
                  {invoice.technicianName}
                </p>
              </div>
            )}
            {m.showServiceAddress && (
              <div className="min-w-[240px]">
                <PartyLabel>Service address</PartyLabel>
                {invoice.customerName && (
                  <p className="text-sm font-semibold text-foreground">
                    {invoice.customerName}
                  </p>
                )}
                <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                  {invoice.customerAddress && <p>{invoice.customerAddress}</p>}
                  {invoice.customerPhone && <p>{invoice.customerPhone}</p>}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── line items table ── */}
        <div className="mt-8 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="rounded-tl-md bg-foreground px-3.5 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.05em] text-background/70">
                  Service / product description
                </th>
                <th className="bg-foreground px-3.5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.05em] text-background/70 tabular-nums">
                  Qty / hrs
                </th>
                <th className="bg-foreground px-3.5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.05em] text-background/70 tabular-nums">
                  Unit price / rate
                </th>
                <th className="rounded-tr-md bg-foreground px-3.5 py-2.5 text-right text-[10px] font-semibold uppercase tracking-[0.05em] text-background/70 tabular-nums">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {invoice.lineItems.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3.5 py-4 text-xs text-muted-foreground">
                    No line items.
                  </td>
                </tr>
              ) : (
                invoice.lineItems.map((li, i) => (
                  <tr
                    key={li.id}
                    className={cn(i % 2 === 1 && 'bg-muted/30')}
                  >
                    <td className="px-3.5 py-3 align-top font-medium text-foreground">
                      {li.name}
                    </td>
                    <td className="px-3.5 py-3 text-right tabular-nums text-muted-foreground">
                      {li.quantity}
                    </td>
                    <td className="px-3.5 py-3 text-right tabular-nums text-muted-foreground">
                      {formatCentsExact(li.unitPriceCents)}
                    </td>
                    <td className="px-3.5 py-3 text-right tabular-nums font-medium text-foreground">
                      {formatCentsExact(li.lineTotalCents)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* ── footer: notes + totals ── */}
        <div className="mt-6 flex flex-wrap justify-between gap-8">
          {/* Notes placeholder */}
          <div className="max-w-sm flex-1">
            <p className="text-xs font-bold text-foreground">Notes</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Thank you for your business. Questions? Call us or reply to your invoice email.
            </p>
          </div>

          {/* Totals */}
          <div className="w-56 shrink-0 space-y-0">
            <TotalsRow label="Subtotal" value={formatCentsExact(invoice.subtotalCents)} />
            {invoice.taxCents > 0 && (
              <TotalsRow label="Sales tax" value={formatCentsExact(invoice.taxCents)} />
            )}
            <div className="mt-1.5 flex justify-between border-t pt-3 text-sm font-bold text-foreground">
              <span>Total</span>
              <span className="tabular-nums">{formatCentsExact(invoice.totalCents)}</span>
            </div>
            <TotalsRow label="Amount paid" value={formatCentsExact(invoice.amountPaidCents)} />
            <div className="mt-2 flex justify-between border-t-2 pt-3 text-[15px] font-extrabold">
              <span>Balance due</span>
              <span
                className={cn(
                  'tabular-nums',
                  m.isOverdue ? 'text-destructive' : 'text-foreground',
                )}
              >
                {formatCentsExact(m.amountDueCents)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── small internal sub-components ──────────────────────────────────────────

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-2.5 odd:bg-muted/30">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground">{label}</span>
      <span className="text-xs font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  );
}

function PartyLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 border-b pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
      {children}
    </p>
  );
}

function TotalsRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1.5 text-sm text-muted-foreground">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
