import { describe, it, expect } from 'vitest';
import { paginate, pageLabel, sortInvoices } from './invoice-list-helpers';
import type { SortableInvoice } from './invoice-list-helpers';

// ─── paginate ────────────────────────────────────────────────────────────────

describe('paginate', () => {
  const rows = Array.from({ length: 100 }, (_, i) => i + 1); // [1..100]

  it('returns [] for an empty array', () => {
    expect(paginate([], 1, 50)).toEqual([]);
  });

  it('returns first 50 items on page 1', () => {
    const result = paginate(rows, 1, 50);
    expect(result).toHaveLength(50);
    expect(result[0]).toBe(1);
    expect(result[49]).toBe(50);
  });

  it('returns items 51–100 on page 2', () => {
    const result = paginate(rows, 2, 50);
    expect(result).toHaveLength(50);
    expect(result[0]).toBe(51);
    expect(result[49]).toBe(100);
  });

  it('returns remaining items on a partial last page', () => {
    const partial = Array.from({ length: 30 }, (_, i) => i + 1);
    const result = paginate(partial, 1, 50);
    expect(result).toHaveLength(30);
  });

  it('returns [] when page is beyond total', () => {
    expect(paginate(rows, 3, 50)).toEqual([]);
    expect(paginate(rows, 100, 50)).toEqual([]);
  });
});

// ─── pageLabel ───────────────────────────────────────────────────────────────

describe('pageLabel', () => {
  it('returns "0 results" when total is 0', () => {
    expect(pageLabel(1, 0, 50)).toBe('0 results');
  });

  it('returns "1–50 of 100" for page 1 of 100 with per=50', () => {
    expect(pageLabel(1, 100, 50)).toBe('1–50 of 100');
  });

  it('returns "51–100 of 100" for page 2 of 100 with per=50', () => {
    expect(pageLabel(2, 100, 50)).toBe('51–100 of 100');
  });

  it('returns "1–30 of 30" for partial last page (30 items, per=50)', () => {
    expect(pageLabel(1, 30, 50)).toBe('1–30 of 30');
  });

  it('returns "1–1 of 1" for single item', () => {
    expect(pageLabel(1, 1, 50)).toBe('1–1 of 1');
  });
});

// ─── sortInvoices ─────────────────────────────────────────────────────────────

const mkInv = (
  createdAt: string,
  totalCents: number,
  amountPaidCents: number,
  state = 'open',
): SortableInvoice => ({ createdAt, totalCents, amountPaidCents, state });

describe('sortInvoices', () => {
  const invoices: SortableInvoice[] = [
    mkInv('2024-01-10T00:00:00Z', 10000, 0),    // oldest, balance 10000
    mkInv('2024-03-15T00:00:00Z', 5000, 5000),  // newest, balance 0 (paid)
    mkInv('2024-02-20T00:00:00Z', 8000, 3000),  // middle, balance 5000
  ];

  it('sorts newest first (descending createdAt)', () => {
    const result = sortInvoices(invoices, 'newest');
    expect(result[0].createdAt).toBe('2024-03-15T00:00:00Z');
    expect(result[1].createdAt).toBe('2024-02-20T00:00:00Z');
    expect(result[2].createdAt).toBe('2024-01-10T00:00:00Z');
  });

  it('sorts oldest first (ascending createdAt)', () => {
    const result = sortInvoices(invoices, 'oldest');
    expect(result[0].createdAt).toBe('2024-01-10T00:00:00Z');
    expect(result[1].createdAt).toBe('2024-02-20T00:00:00Z');
    expect(result[2].createdAt).toBe('2024-03-15T00:00:00Z');
  });

  it('sorts by balance descending (balance-high)', () => {
    const result = sortInvoices(invoices, 'balance-high');
    // balance 10000, 5000, 0
    expect(result[0].totalCents - result[0].amountPaidCents).toBe(10000);
    expect(result[1].totalCents - result[1].amountPaidCents).toBe(5000);
    expect(result[2].totalCents - result[2].amountPaidCents).toBe(0);
  });

  it('sorts age-oldest: oldest unpaid first, paid last', () => {
    const result = sortInvoices(invoices, 'age-oldest');
    // oldest unpaid: 2024-01-10 (balance 10000)
    // middle unpaid: 2024-02-20 (balance 5000)
    // paid (daysOld = -1): 2024-03-15
    expect(result[0].createdAt).toBe('2024-01-10T00:00:00Z');
    expect(result[1].createdAt).toBe('2024-02-20T00:00:00Z');
    expect(result[2].createdAt).toBe('2024-03-15T00:00:00Z');
  });

  it('does not mutate the input array', () => {
    const original = [...invoices];
    sortInvoices(invoices, 'newest');
    expect(invoices).toEqual(original);
  });
});
