import { invoiceRef } from '@/lib/communication/money-triggers';
import type { InvoiceDetailView } from '@/lib/admin/invoice-queries';

const NET_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export interface InvoiceDocModel {
  readonly invoiceRef: string;
  readonly invoiceDate: Date;
  readonly serviceDate: Date | null;
  readonly dueDate: Date;
  readonly amountDueCents: number;
  readonly isOverdue: boolean;
  readonly showTechnician: boolean;
  readonly showServiceAddress: boolean;
}

export function invoiceDocModel(inv: InvoiceDetailView): InvoiceDocModel {
  const amountDueCents = inv.totalCents - inv.amountPaidCents;
  return {
    invoiceRef: invoiceRef(inv.id),
    invoiceDate: new Date(inv.createdAt),
    serviceDate: inv.serviceDate ? new Date(inv.serviceDate) : null,
    dueDate: new Date(new Date(inv.createdAt).getTime() + NET_DAYS_MS),
    amountDueCents,
    isOverdue: amountDueCents > 0,
    showTechnician: inv.technicianName != null,
    showServiceAddress:
      inv.customerName != null || inv.customerAddress != null || inv.customerPhone != null,
  };
}
