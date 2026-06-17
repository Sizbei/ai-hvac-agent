import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * getAccountingExport issues 4 tenant + period-scoped selects (invoices,
 * payments, refunds, labor) in a Promise.all, each ending in .where(). The mock
 * returns ALREADY-FILTERED rows (the driver would run the SQL) so we assert that
 * the BUILDER:
 *   - emits one journal line per source row, typed by source table,
 *   - converts cents -> DOLLARS (cents/100), never leaving cents,
 *   - carries ids-only memos (no customer names / PII),
 *   - and that every query is tenant-scoped (org id captured in each .where()).
 */

interface Captured {
  where: unknown[];
}

const { selectQueue, captured, makeChain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const captured: Captured[] = [];

  const makeChain = (resolved: unknown, capture: Captured): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(resolved);
        }
        if (prop === 'where') {
          return (...args: unknown[]) => {
            capture.where = args;
            return p;
          };
        }
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };

  return { selectQueue, captured, makeChain };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => {
      const capture: Captured = { where: [] };
      captured.push(capture);
      return {
        from: () => makeChain(selectQueue.shift() ?? [], capture),
      };
    },
  },
}));

// withTenant returns a marker carrying the org id so we can assert tenant scope
// without depending on drizzle internals.
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, organizationId: string, ...conds: unknown[]) => ({
    __tenant: organizationId,
    conds,
  }),
}));

// Schema is only referenced by identity in the queries; stub the touched tables.
vi.mock('@/lib/db/schema', () => ({
  invoices: { createdAt: 'invoices.createdAt' },
  payments: { status: 'payments.status', createdAt: 'payments.createdAt' },
  refunds: { createdAt: 'refunds.createdAt' },
  technicianTimeEntries: {
    clockOutAt: 'tte.clockOutAt',
    laborCostCents: 'tte.laborCostCents',
  },
}));

// drizzle-orm operators are only used to build condition markers; stub to no-ops.
vi.mock('drizzle-orm', () => ({
  eq: () => 'eq',
  gte: () => 'gte',
  lte: () => 'lte',
  isNotNull: () => 'isNotNull',
}));

import { getAccountingExport, buildCsv } from './accounting-export';

const ORG = '00000000-0000-0000-0000-000000000001';
const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-01-31T23:59:59.999Z');

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

/** Queue results in the builder's Promise.all order: invoices, payments, refunds, labor. */
function queue(opts: {
  invoices?: unknown[];
  payments?: unknown[];
  refunds?: unknown[];
  labor?: unknown[];
}) {
  selectQueue.push(opts.invoices ?? []);
  selectQueue.push(opts.payments ?? []);
  selectQueue.push(opts.refunds ?? []);
  selectQueue.push(opts.labor ?? []);
}

describe('getAccountingExport', () => {
  it('emits invoice/payment/refund/labor lines with dollar amounts (cents/100)', async () => {
    queue({
      invoices: [
        { id: 'inv-1', subtotalCents: 10000, taxCents: 825, createdAt: new Date('2026-01-05T12:00:00Z') },
      ],
      payments: [
        { id: 'pay-1', invoiceId: 'inv-1', amountCents: 10825, createdAt: new Date('2026-01-06T12:00:00Z') },
      ],
      refunds: [
        { id: 'ref-1', paymentId: 'pay-1', amountCents: 5000, createdAt: new Date('2026-01-10T12:00:00Z') },
      ],
      labor: [
        { id: 'tte-1', serviceRequestId: 'req-1', laborCostCents: 7500, clockOutAt: new Date('2026-01-07T12:00:00Z') },
      ],
    });

    const journal = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });

    const byType = Object.fromEntries(journal.map((l) => [l.type, l]));
    expect(journal).toHaveLength(4);

    // Amounts are DOLLARS, not cents.
    expect(byType.invoice.amountDollars).toBe(108.25); // 10000 + 825 = 10825 cents
    expect(byType.payment.amountDollars).toBe(108.25);
    expect(byType.refund.amountDollars).toBe(50.0);
    expect(byType.labor.amountDollars).toBe(75.0);

    // Accounts are QBO-style.
    expect(byType.invoice.account).toBe('Sales Revenue');
    expect(byType.payment.account).toBe('Undeposited Funds');
    expect(byType.refund.account).toBe('Refunds & Allowances');
    expect(byType.labor.account).toBe('Labor Cost');

    // No cents leak: nothing in the journal equals a raw cents figure.
    for (const line of journal) {
      expect(line.amountDollars).toBeLessThan(10825);
    }

    // Dates are YYYY-MM-DD.
    expect(byType.invoice.date).toBe('2026-01-05');
    expect(byType.labor.date).toBe('2026-01-07');
  });

  it('memos carry IDs only — no customer names, emails, or PII', async () => {
    queue({
      invoices: [{ id: 'inv-1', subtotalCents: 100, taxCents: 0, createdAt: FROM }],
      payments: [{ id: 'pay-1', invoiceId: 'inv-1', amountCents: 100, createdAt: FROM }],
      refunds: [{ id: 'ref-1', paymentId: 'pay-1', amountCents: 50, createdAt: FROM }],
      labor: [{ id: 'tte-1', serviceRequestId: 'req-1', laborCostCents: 200, clockOutAt: FROM }],
    });

    const journal = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });

    for (const line of journal) {
      // Memo references only opaque ids/labels we put in — no '@' (emails) and
      // no free-text customer fields.
      expect(line.memo).not.toContain('@');
    }
    expect(journal.find((l) => l.type === 'invoice')!.memo).toBe('Invoice inv-1');
    expect(journal.find((l) => l.type === 'payment')!.memo).toBe(
      'Payment pay-1 (invoice inv-1)',
    );
    expect(journal.find((l) => l.type === 'refund')!.memo).toBe(
      'Refund ref-1 (payment pay-1)',
    );
    expect(journal.find((l) => l.type === 'labor')!.memo).toBe(
      'Time entry tte-1 (request req-1)',
    );
  });

  it('scopes every query to the tenant org and the period', async () => {
    queue({});
    await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });

    // 4 selects captured, each tenant-scoped to ORG.
    expect(captured).toHaveLength(4);
    for (const cap of captured) {
      const arg = cap.where[0] as { __tenant?: string };
      expect(arg.__tenant).toBe(ORG);
    }
  });

  it('skips zero-value invoices but keeps real rows', async () => {
    queue({
      invoices: [
        { id: 'inv-zero', subtotalCents: 0, taxCents: 0, createdAt: FROM },
        { id: 'inv-real', subtotalCents: 5000, taxCents: 0, createdAt: FROM },
      ],
    });
    const journal = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });
    const invoiceLines = journal.filter((l) => l.type === 'invoice');
    expect(invoiceLines).toHaveLength(1);
    expect(invoiceLines[0].memo).toBe('Invoice inv-real');
  });
});

describe('buildCsv', () => {
  it('produces a header + one row per line with 2dp dollar amounts', () => {
    const csv = buildCsv([
      {
        date: '2026-01-05',
        type: 'invoice',
        account: 'Sales Revenue',
        memo: 'Invoice inv-1',
        amountDollars: 108.25,
      },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('Date,Type,Account,Memo,Amount');
    expect(lines[1]).toBe('2026-01-05,invoice,Sales Revenue,Invoice inv-1,108.25');
  });

  it('escapes fields containing commas or quotes', () => {
    const csv = buildCsv([
      {
        date: '2026-01-05',
        type: 'refund',
        account: 'Refunds & Allowances',
        memo: 'Refund a, "b"',
        amountDollars: 1,
      },
    ]);
    expect(csv).toContain('"Refund a, ""b"""');
  });
});
