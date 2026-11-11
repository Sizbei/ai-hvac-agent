import { describe, expect, it } from 'vitest';
import {
  invoiceBalanceCents,
  previewRows,
  sharedSyncSource,
  summarizeInvoices,
} from './customer-money-summary';

describe('invoiceBalanceCents', () => {
  it('owes only on open invoices', () => {
    expect(invoiceBalanceCents({ state: 'open', totalCents: 10_000, amountPaidCents: 2_500 })).toBe(7_500);
    expect(invoiceBalanceCents({ state: 'paid', totalCents: 10_000, amountPaidCents: 10_000 })).toBe(0);
    expect(invoiceBalanceCents({ state: 'draft', totalCents: 10_000, amountPaidCents: 0 })).toBe(0);
  });
  it('never goes below zero on an overpaid invoice', () => {
    expect(invoiceBalanceCents({ state: 'open', totalCents: 1_000, amountPaidCents: 1_500 })).toBe(0);
  });
});

describe('summarizeInvoices', () => {
  it('bills everything but drafts and voids and sums open balances', () => {
    expect(
      summarizeInvoices([
        { state: 'paid', totalCents: 53_000, amountPaidCents: 53_000 },
        { state: 'open', totalCents: 122_200, amountPaidCents: 0 },
        { state: 'open', totalCents: 10_000, amountPaidCents: 4_000 },
        { state: 'draft', totalCents: 0, amountPaidCents: 0 },
        { state: 'void', totalCents: 9_900, amountPaidCents: 0 },
        { state: 'refunded', totalCents: 5_000, amountPaidCents: 5_000 },
      ]),
    ).toEqual({ billedCents: 190_200, openBalanceCents: 128_200, openCount: 2 });
  });
  it('is all zeros for no invoices', () => {
    expect(summarizeInvoices([])).toEqual({ billedCents: 0, openBalanceCents: 0, openCount: 0 });
  });
});

describe('previewRows', () => {
  const rows = Array.from({ length: 12 }, (_, i) => i);
  it('shows the first few until expanded', () => {
    expect(previewRows(rows, false)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(previewRows(rows, true)).toHaveLength(12);
    expect(previewRows([1, 2], false)).toEqual([1, 2]);
  });
});

describe('sharedSyncSource', () => {
  it('names the source every row shares', () => {
    expect(sharedSyncSource([{ syncedSource: 'fieldpulse' }, { syncedSource: 'fieldpulse' }])).toBe('fieldpulse');
  });
  it('is null for mixed, native or empty lists', () => {
    expect(sharedSyncSource([{ syncedSource: 'fieldpulse' }, { syncedSource: null }])).toBeNull();
    expect(sharedSyncSource([{ syncedSource: null }])).toBeNull();
    expect(sharedSyncSource([])).toBeNull();
  });
});
