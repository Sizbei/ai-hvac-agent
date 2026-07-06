import { it, expect, vi } from 'vitest';
// money-triggers imports portal-queries which has `import "server-only"`.
// Stub it so the vitest node env doesn't throw.
vi.mock('server-only', () => ({}));
import { invoiceDocModel } from './invoice-document-model';

const base = {
  id: '1042abcd', totalCents: 248000, amountPaidCents: 0,
  technicianName: 'Davis Reed', serviceDate: new Date('2026-04-22'),
  customerName: 'Marta Delgado', customerAddress: '118 Ash St', customerPhone: '(423) 555-0148',
  createdAt: new Date('2026-04-23'),
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

it('computes amount due, overdue flag, and net-30 due date', () => {
  const m = invoiceDocModel(base);
  expect(m.amountDueCents).toBe(248000);
  expect(m.isOverdue).toBe(true);
  expect(m.invoiceRef).toBe('#1042ABCD'); // invoiceRef uppercases the 8-char prefix
  expect(m.dueDate).toEqual(new Date(new Date('2026-04-23').getTime() + 30*24*3600*1000));
});
it('flags which optional blocks to show', () => {
  expect(invoiceDocModel(base).showTechnician).toBe(true);
  expect(invoiceDocModel({ ...base, technicianName: null }).showTechnician).toBe(false);
  expect(invoiceDocModel({ ...base, customerName: null, customerAddress: null, customerPhone: null }).showServiceAddress).toBe(false);
});
it('amountDue 0 when fully paid → not overdue', () => {
  const m = invoiceDocModel({ ...base, amountPaidCents: 248000 });
  expect(m.amountDueCents).toBe(0);
  expect(m.isOverdue).toBe(false);
});
