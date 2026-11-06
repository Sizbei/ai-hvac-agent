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
    issuedAt: 'invoices.issuedAt',
    fieldpulseInvoiceId: 'invoices.fieldpulseInvoiceId',
    hcpInvoiceId: 'invoices.hcpInvoiceId',
  },
  payments: {
    id: 'payments.id',
    invoiceId: 'payments.invoiceId',
    organizationId: 'payments.organizationId',
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

// drizzle-orm operators are only used to build condition markers; stub to
// no-ops, but capture args for gte/lte/sql so tests can assert which column
// expression (raw createdAt vs. coalesce(issuedAt, createdAt)) is filtered on.
vi.mock('drizzle-orm', () => ({
  eq: () => 'eq',
  gte: (left: unknown, right: unknown) => ({ kind: 'gte', left, right }),
  lte: (left: unknown, right: unknown) => ({ kind: 'lte', left, right }),
  and: (...conds: unknown[]) => ({ kind: 'and', conds }),
  or: (...conds: unknown[]) => ({ kind: 'or', conds }),
  isNull: (col: unknown) => ({ kind: 'isNull', col }),
  isNotNull: (col: unknown) => ({ kind: 'isNotNull', col }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    kind: 'sql',
    strings: [...strings],
    values,
  }),
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
    expect(native).toHaveLength(5);

    // Amounts are DOLLARS, not cents. Revenue is the subtotal; tax is its own
    // row on Sales Tax Payable (owed to the state, not earned).
    expect(byType.invoice.amountDollars).toBe(100);
    expect(byType.tax.amountDollars).toBe(8.25);
    expect(byType.tax.account).toBe('Sales Tax Payable');
    expect(byType.tax.ref).toBe('inv-1');
    expect(byType.payment.amountDollars).toBe(108.25);
    expect(byType.refund.amountDollars).toBe(-50.0); // money out is negative
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
      nativePayments: [{ id: 'pay-1', invoiceId: 'inv-1', amountCents: 100, method: 'check', createdAt: FROM }],
      syncedPayments: [{ id: 'pay-fp', invoiceId: 'inv-fp', amountCents: 100, method: 'card', createdAt: FROM }],
      refunds: [{ id: 'ref-1', paymentId: 'pay-1', invoiceId: 'inv-1', amountCents: 50, createdAt: FROM }],
      labor: [{ id: 'tte-1', serviceRequestId: 'req-1', laborCostCents: 200, clockOutAt: FROM }],
    });

    const result = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });
    const native = result.native;

    for (const line of native) {
      // Memo references only opaque ids/labels we put in — no '@' (emails) and
      // no free-text customer fields.
      expect(line.memo).not.toContain('@');
    }
    // Memos use the #XXXXXXXX refs the app shows; the full id is the Reference.
    expect(native.find((l) => l.type === 'invoice')!.memo).toBe('Invoice #INV-1');
    expect(native.find((l) => l.type === 'invoice')!.ref).toBe('inv-1');
    expect(native.find((l) => l.type === 'payment')!.memo).toBe(
      'Payment on invoice #INV-1 (check)',
    );
    expect(native.find((l) => l.type === 'payment')!.ref).toBe('pay-1');
    expect(result.synced.find((l) => l.type === 'payment')!.memo).toBe(
      'Payment on invoice #INV-FP (card)',
    );
    // Refunds name the invoice the office knows, not the payment.
    expect(native.find((l) => l.type === 'refund')!.memo).toBe('Refund on invoice #INV-1');
    expect(native.find((l) => l.type === 'labor')!.memo).toBe('Labor on request #REQ-1');
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
    expect(invoiceLines[0].ref).toBe('inv-real');
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
    expect(result.native.find((l) => l.type === 'invoice')!.ref).toBe('inv-n1');
    expect(result.native.filter((l) => l.type === 'payment')).toHaveLength(1);

    // Synced section: 1 invoice + 1 payment — separate, not blended with native
    expect(result.synced.filter((l) => l.type === 'invoice')).toHaveLength(1);
    expect(result.synced.find((l) => l.type === 'invoice')!.ref).toBe('inv-fp1');
    expect(result.synced.filter((l) => l.type === 'payment')).toHaveLength(1);

    // The FP invoice does NOT appear in native and vice versa
    expect(result.native.some((l) => l.ref === 'inv-fp1')).toBe(false);
    expect(result.synced.some((l) => l.ref === 'inv-n1')).toBe(false);
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

  // Raccounting-1: synced invoices are filtered/dated by coalesce(issuedAt,
  // createdAt) — the real source-system invoice date — not raw createdAt (the
  // row's IMPORT time). Native rows are unaffected (issuedAt is always null
  // there, so the coalesce no-ops) and keep using createdAt.
  it('synced invoice query filters by coalesce(issuedAt, createdAt), not raw createdAt', async () => {
    queue({});
    await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });

    // 2nd captured = synced invoices query.
    const syncedInvWhere = JSON.stringify(captured[1]?.where ?? []);
    expect(syncedInvWhere).toContain('coalesce');
    expect(syncedInvWhere).toContain('invoices.issuedAt');
    expect(syncedInvWhere).toContain('invoices.createdAt');

    // 1st captured = native invoices query — still raw createdAt, no coalesce.
    const nativeInvWhere = JSON.stringify(captured[0]?.where ?? []);
    expect(nativeInvWhere).not.toContain('coalesce');
  });

  it('dates a synced invoice by issuedAt, not the import-time createdAt (Raccounting-1)', async () => {
    // Real example from the spec: FP invoice issued 2025-10-30, but the row
    // wasn't imported into our DB (createdAt) until 2026-07-07. A DB-level
    // coalesce(issuedAt, createdAt) filter would include this row in an
    // October-2025 export (issuedAt in-period) even though createdAt falls far
    // outside it; the builder must date the journal line by issuedAt.
    queue({
      syncedInvoices: [
        {
          id: 'inv-fp-late-import',
          subtotalCents: 10000,
          taxCents: 0,
          issuedAt: new Date('2025-10-30T12:00:00Z'),
          createdAt: new Date('2026-07-07T09:00:00Z'),
          fieldpulseInvoiceId: 'fp-inv-1',
          hcpInvoiceId: null,
        },
      ],
    });

    const result = await getAccountingExport(ORG, {
      fromDate: new Date('2025-10-01T00:00:00.000Z'),
      toDate: new Date('2025-10-31T23:59:59.999Z'),
    });

    expect(result.synced).toHaveLength(1);
    expect(result.synced[0].date).toBe('2025-10-30');
    expect(result.synced[0].date).not.toBe('2026-07-07');
  });
});

describe('buildCsv', () => {
  const nativeLine = {
    date: '2026-01-05',
    type: 'invoice' as const,
    account: 'Sales Revenue' as const,
    ref: 'inv-1',
    memo: 'Invoice #INV-1',
    amountDollars: 108.25,
  };

  const syncedLine = {
    date: '2026-01-06',
    type: 'invoice' as const,
    account: 'Sales Revenue' as const,
    ref: 'fp-1',
    memo: 'Invoice #FP-1',
    amountDollars: 200.0,
    source: 'fieldpulse' as const,
  };

  it('is one header plus one row per transaction — no comment or subtotal rows', () => {
    const csv = buildCsv({ native: [nativeLine], synced: [syncedLine] });
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('Date,Type,Account,Reference,Memo,Amount,Import');
    expect(lines).toHaveLength(3);
    expect(lines.some((l) => l.startsWith('#'))).toBe(false);
    expect(csv).not.toMatch(/subtotal/i);
    // No blended grand total either.
    expect(csv).not.toContain('308.25');
  });

  it('marks which rows to import: native yes, mirrored no', () => {
    const csv = buildCsv({ native: [nativeLine], synced: [syncedLine] });
    expect(csv).toContain('2026-01-05,invoice,Sales Revenue,inv-1,Invoice #INV-1,108.25,Yes');
    expect(csv).toContain('2026-01-06,invoice,Sales Revenue,fp-1,Invoice #FP-1,200.00,No — already in FieldPulse');
    const hcp = buildCsv({ native: [], synced: [{ ...syncedLine, source: 'housecall' as const }] });
    expect(hcp).toContain('No — already in HCP');
  });

  it('writes refunds as negative amounts', async () => {
    queue({ refunds: [{ id: 'ref-1', paymentId: 'pay-1', amountCents: 5000, createdAt: FROM }] });
    const result = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });
    expect(result.native[0]!.amountDollars).toBe(-50);
    expect(buildCsv(result)).toContain(',-50.00,Yes');
  });

  it('drops $0 labor rows', async () => {
    queue({
      labor: [
        { id: 'tte-0', serviceRequestId: 'req-1', laborCostCents: 0, clockOutAt: FROM },
        { id: 'tte-1', serviceRequestId: 'req-1', laborCostCents: 1500, clockOutAt: FROM },
      ],
    });
    const result = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });
    expect(result.native.map((l) => l.ref)).toEqual(['tte-1']);
  });

  it('escapes fields containing commas or quotes', () => {
    const refundLine = {
      date: '2026-01-05',
      type: 'refund' as const,
      account: 'Refunds & Allowances' as const,
      ref: 'ref-1',
      memo: 'Refund a, "b"',
      amountDollars: -1,
    };
    const csv = buildCsv({ native: [refundLine], synced: [] });
    expect(csv).toContain('"Refund a, ""b"""');
  });
});

describe('sales tax, business-day dates and order (round-2 books fixes)', () => {
  it('books tax to Sales Tax Payable on its own row — revenue is the subtotal only', async () => {
    queue({
      nativeInvoices: [
        { id: 'afa28e5d-0000', subtotalCents: 41000, taxCents: 3895, createdAt: new Date('2026-11-05T15:00:00Z') },
        { id: 'notax-0000', subtotalCents: 5000, taxCents: 0, createdAt: new Date('2026-11-05T15:00:00Z') },
      ],
    });
    const { native } = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });
    const revenue = native.filter((l) => l.account === 'Sales Revenue');
    const tax = native.filter((l) => l.account === 'Sales Tax Payable');
    expect(revenue.map((l) => l.amountDollars)).toEqual([410, 50]);
    expect(tax).toHaveLength(1);
    expect(tax[0]).toMatchObject({ type: 'tax', amountDollars: 38.95, memo: 'Sales tax on invoice #AFA28E5D' });
    const csv = buildCsv({ native, synced: [] });
    expect(csv).toContain('2026-11-05,tax,Sales Tax Payable,afa28e5d-0000,Sales tax on invoice #AFA28E5D,38.95,Yes');
  });

  it('splits tax on mirrored invoices too, keeping their Import = No', async () => {
    queue({
      syncedInvoices: [
        { id: 'fp-1', subtotalCents: 10000, taxCents: 700, createdAt: FROM, issuedAt: null, fieldpulseInvoiceId: 'x', hcpInvoiceId: null },
      ],
    });
    const { synced } = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });
    expect(synced.map((l) => [l.account, l.amountDollars, l.source])).toEqual([
      ['Sales Revenue', 100, 'fieldpulse'],
      ['Sales Tax Payable', 7, 'fieldpulse'],
    ]);
  });

  it('dates rows in the business time zone: an 8 pm Eastern payment on Nov 5 is Nov 5', async () => {
    queue({
      nativePayments: [
        { id: 'pay-eve', invoiceId: 'inv-1', amountCents: 100, method: 'cash', createdAt: new Date('2026-11-06T01:00:00Z') },
      ],
    });
    const { native } = await getAccountingExport(ORG, {
      fromDate: FROM,
      toDate: TO,
      timeZone: 'America/New_York',
    });
    expect(native[0]!.date).toBe('2026-11-05');
  });

  it('sorts rows by date, keeping an invoice before its tax', async () => {
    queue({
      nativeInvoices: [
        { id: 'inv-late', subtotalCents: 100, taxCents: 10, createdAt: new Date('2026-11-06T15:00:00Z') },
      ],
      nativePayments: [
        { id: 'pay-early', invoiceId: 'inv-x', amountCents: 100, method: 'cash', createdAt: new Date('2026-11-05T15:00:00Z') },
      ],
      refunds: [
        { id: 'ref-mid', paymentId: 'pay-early', invoiceId: null, amountCents: 50, createdAt: new Date('2026-11-05T20:00:00Z') },
      ],
    });
    const { native } = await getAccountingExport(ORG, { fromDate: FROM, toDate: TO });
    expect(native.map((l) => `${l.date} ${l.type}`)).toEqual([
      '2026-11-05 payment',
      '2026-11-05 refund',
      '2026-11-06 invoice',
      '2026-11-06 tax',
    ]);
    // A refund whose payment has no invoice falls back to the payment ref.
    expect(native[1]!.memo).toBe('Refund on payment #PAY-EARL');
  });
});
