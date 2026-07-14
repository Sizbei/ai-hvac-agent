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
  invoices: {
    createdAt: 'invoices.createdAt',
    fieldpulseInvoiceId: 'invoices.fieldpulseInvoiceId',
    hcpInvoiceId: 'invoices.hcpInvoiceId',
  },
  payments: {
    status: 'payments.status',
    createdAt: 'payments.createdAt',
    fieldpulsePaymentId: 'payments.fieldpulsePaymentId',
  },
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
  and: (...conds: unknown[]) => ({ kind: 'and', conds }),
  or: (...conds: unknown[]) => ({ kind: 'or', conds }),
  isNull: (col: unknown) => ({ kind: 'isNull', col }),
  isNotNull: (col: unknown) => ({ kind: 'isNotNull', col }),
}));

import { getAccountingExport, buildCsv } from './accounting-export';

const ORG = '00000000-0000-0000-0000-000000000001';
const FROM = new Date('2026-01-01T00:00:00.000Z');
const TO = new Date('2026-01-31T23:59:59.999Z');

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

/**
 * Queue results in the builder's Promise.all order:
 * nativeInvoices, syncedInvoices, nativePayments, syncedPayments, refunds, labor.
 */
function queue(opts: {
  nativeInvoices?: unknown[];
  syncedInvoices?: unknown[];
  nativePayments?: unknown[];
  syncedPayments?: unknown[];
  refunds?: unknown[];
  labor?: unknown[];
  // Convenience aliases that map to native-only (old callers).
  invoices?: unknown[];
  payments?: unknown[];
}) {
  selectQueue.push(opts.nativeInvoices ?? opts.invoices ?? []);
  selectQueue.push(opts.syncedInvoices ?? []);
  selectQueue.push(opts.nativePayments ?? opts.payments ?? []);
  selectQueue.push(opts.syncedPayments ?? []);
  selectQueue.push(opts.refunds ?? []);
  selectQueue.push(opts.labor ?? []);
}

describe('getAccountingExport', () => {
  it('emits invoice/payment/refund/labor lines with dollar amounts (cents/100)', async () => {
    queue({
      nativeInvoices: [
        { id: 'inv-1', subtotalCents: 10000, taxCents: 825, createdAt: new Date('2026-01-05T12:00:00Z') },
      ],
      nativePayments: [
        { id: 'pay-1', invoiceId: 'inv-1', amountCents: 10825, createdAt: new Date('2026-01-06T12:00:00Z') },
      ],
      refunds: [
        { id: 'ref-1', paymentId: 'pay-1', amountCents: 5000, createdAt: new Date('2026-01-10T12:00:00Z') },
      ],
      labor: [
        { id: 'tte-1', serviceRequestId: 'req-1', laborCostCents: 7500, clockOutAt: new Date('2026-01-07T12:00:00Z') },
      ],
    });

    const result = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });
    const native = result.native;

    const byType = Object.fromEntries(native.map((l) => [l.type, l]));
    expect(native).toHaveLength(4);

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
    for (const line of native) {
      expect(line.amountDollars).toBeLessThan(10825);
    }

    // Dates are YYYY-MM-DD.
    expect(byType.invoice.date).toBe('2026-01-05');
    expect(byType.labor.date).toBe('2026-01-07');
  });

  it('memos carry IDs only — no customer names, emails, or PII', async () => {
    queue({
      nativeInvoices: [{ id: 'inv-1', subtotalCents: 100, taxCents: 0, createdAt: FROM }],
      nativePayments: [{ id: 'pay-1', invoiceId: 'inv-1', amountCents: 100, createdAt: FROM }],
      refunds: [{ id: 'ref-1', paymentId: 'pay-1', amountCents: 50, createdAt: FROM }],
      labor: [{ id: 'tte-1', serviceRequestId: 'req-1', laborCostCents: 200, clockOutAt: FROM }],
    });

    const result = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });
    const native = result.native;

    for (const line of native) {
      // Memo references only opaque ids/labels we put in — no '@' (emails) and
      // no free-text customer fields.
      expect(line.memo).not.toContain('@');
    }
    expect(native.find((l) => l.type === 'invoice')!.memo).toBe('Invoice inv-1');
    expect(native.find((l) => l.type === 'payment')!.memo).toBe(
      'Payment pay-1 (invoice inv-1)',
    );
    expect(native.find((l) => l.type === 'refund')!.memo).toBe(
      'Refund ref-1 (payment pay-1)',
    );
    expect(native.find((l) => l.type === 'labor')!.memo).toBe(
      'Time entry tte-1 (request req-1)',
    );
  });

  it('scopes every query to the tenant org and the period', async () => {
    queue({});
    await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });

    // 6 selects captured (nativeInvoices, syncedInvoices, nativePayments,
    // syncedPayments, refunds, labor), each tenant-scoped to ORG.
    expect(captured).toHaveLength(6);
    for (const cap of captured) {
      const arg = cap.where[0] as { __tenant?: string };
      expect(arg.__tenant).toBe(ORG);
    }
  });

  it('skips zero-value invoices but keeps real rows', async () => {
    queue({
      nativeInvoices: [
        { id: 'inv-zero', subtotalCents: 0, taxCents: 0, createdAt: FROM },
        { id: 'inv-real', subtotalCents: 5000, taxCents: 0, createdAt: FROM },
      ],
    });
    const result = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });
    const invoiceLines = result.native.filter((l) => l.type === 'invoice');
    expect(invoiceLines).toHaveLength(1);
    expect(invoiceLines[0].memo).toBe('Invoice inv-real');
  });

  it('partitions native and synced rows into separate sections — subtotals never blend', async () => {
    queue({
      nativeInvoices: [
        { id: 'inv-n1', subtotalCents: 10000, taxCents: 0, createdAt: FROM },
      ],
      syncedInvoices: [
        { id: 'inv-fp1', subtotalCents: 50000, taxCents: 0, createdAt: FROM },
      ],
      nativePayments: [
        { id: 'pay-n1', invoiceId: 'inv-n1', amountCents: 10000, createdAt: FROM },
      ],
      syncedPayments: [
        { id: 'pay-fp1', invoiceId: 'inv-fp1', amountCents: 50000, createdAt: FROM },
      ],
    });

    const result = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });

    // Native section: 1 invoice + 1 payment
    expect(result.native.filter((l) => l.type === 'invoice')).toHaveLength(1);
    expect(result.native.find((l) => l.type === 'invoice')!.memo).toBe('Invoice inv-n1');
    expect(result.native.filter((l) => l.type === 'payment')).toHaveLength(1);

    // Synced section: 1 invoice + 1 payment — separate, not blended with native
    expect(result.synced.filter((l) => l.type === 'invoice')).toHaveLength(1);
    expect(result.synced.find((l) => l.type === 'invoice')!.memo).toBe('Invoice inv-fp1');
    expect(result.synced.filter((l) => l.type === 'payment')).toHaveLength(1);

    // The FP invoice does NOT appear in native and vice versa
    expect(result.native.some((l) => l.memo.includes('inv-fp1'))).toBe(false);
    expect(result.synced.some((l) => l.memo.includes('inv-n1'))).toBe(false);
  });

  it('native query carries IS NULL discriminators; synced query carries IS NOT NULL', async () => {
    queue({});
    await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });

    // 1st captured = native invoices query
    const nativeInvWhere = JSON.stringify(captured[0]?.where ?? []);
    expect(nativeInvWhere).toContain('isNull');
    expect(nativeInvWhere).toContain('invoices.fieldpulseInvoiceId');
    expect(nativeInvWhere).toContain('invoices.hcpInvoiceId');

    // 2nd captured = synced invoices query (OR of fp + hcp)
    const syncedInvWhere = JSON.stringify(captured[1]?.where ?? []);
    expect(syncedInvWhere).toContain('isNotNull');
    expect(syncedInvWhere).toContain('invoices.fieldpulseInvoiceId');
    expect(syncedInvWhere).toContain('invoices.hcpInvoiceId');

    // 3rd captured = native payments query
    const nativePayWhere = JSON.stringify(captured[2]?.where ?? []);
    expect(nativePayWhere).toContain('isNull');
    expect(nativePayWhere).toContain('payments.fieldpulsePaymentId');

    // 4th captured = synced payments query
    const syncedPayWhere = JSON.stringify(captured[3]?.where ?? []);
    expect(syncedPayWhere).toContain('isNotNull');
    expect(syncedPayWhere).toContain('payments.fieldpulsePaymentId');
  });
});

describe('buildCsv', () => {
  const nativeLine = {
    date: '2026-01-05',
    type: 'invoice' as const,
    account: 'Sales Revenue' as const,
    memo: 'Invoice inv-1',
    amountDollars: 108.25,
  };

  const syncedLine = {
    date: '2026-01-06',
    type: 'invoice' as const,
    account: 'Sales Revenue' as const,
    memo: 'Invoice fp-1',
    amountDollars: 200.00,
  };

  it('produces header + native section + synced section with separate subtotals', () => {
    const csv = buildCsv({ native: [nativeLine], synced: [syncedLine] });
    // Header first
    expect(csv).toContain('Date,Type,Account,Memo,Amount');
    // Native section marker
    expect(csv).toContain('# NATIVE');
    expect(csv).toContain('Invoice inv-1');
    expect(csv).toContain('Native subtotal');
    expect(csv).toContain('108.25');
    // Synced section marker
    expect(csv).toContain('# SYNCED FROM EXTERNAL SOURCE');
    expect(csv).toContain('Invoice fp-1');
    expect(csv).toContain('FieldPulse synced subtotal');
    expect(csv).toContain('200.00');
    // No blended grand total
    expect(csv).not.toContain('308.25');
  });

  it('native line has 2dp dollar amounts', () => {
    const csv = buildCsv({ native: [nativeLine], synced: [] });
    expect(csv).toContain('2026-01-05,invoice,Sales Revenue,Invoice inv-1,108.25');
  });

  it('escapes fields containing commas or quotes', () => {
    const refundLine = {
      date: '2026-01-05',
      type: 'refund' as const,
      account: 'Refunds & Allowances' as const,
      memo: 'Refund a, "b"',
      amountDollars: 1,
    };
    const csv = buildCsv({ native: [refundLine], synced: [] });
    expect(csv).toContain('"Refund a, ""b"""');
  });
});
