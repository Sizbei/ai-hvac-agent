import { invoiceRef } from '@/lib/admin/invoice-collectible';
import type { InvoiceDetailView } from '@/lib/admin/invoice-queries';

const NET_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface InvoiceDocModel {
  readonly invoiceRef: string;
  readonly invoiceDate: Date;
  readonly serviceDate: Date | null;
  readonly dueDate: Date;
  /** True when dueDate is our net-30 fallback (no source-system due date) —
   * only then may the document label the terms "Net 30". */
  readonly derivedNetTerms: boolean;
  readonly amountDueCents: number;
  readonly isOverdue: boolean;
  readonly showTechnician: boolean;
  readonly showServiceAddress: boolean;
}

export function invoiceDocModel(inv: InvoiceDetailView, now: Date = new Date()): InvoiceDocModel {
  const amountDueCents = inv.totalCents - inv.amountPaidCents;
  // Real issue date when the source system provides one (FP/HCP mirrors);
  // row-creation time only for native invoices.
  const invoiceDate = new Date(inv.issuedAt ?? inv.createdAt);
  const dueDate = inv.dueDate ? new Date(inv.dueDate) : new Date(invoiceDate.getTime() + NET_DAYS_MS);
  return {
    invoiceRef: invoiceRef(inv.id),
    invoiceDate,
    serviceDate: inv.serviceDate ? new Date(inv.serviceDate) : null,
    dueDate,
    derivedNetTerms: inv.dueDate == null,
    amountDueCents,
    // Red means overdue: a balance on a fresh invoice is just a balance.
    isOverdue: amountDueCents > 0 && dueDate.getTime() < now.getTime(),
    showTechnician: inv.technicianName != null,
    showServiceAddress:
      inv.customerName != null || inv.customerAddress != null || inv.customerPhone != null,
  };
}
