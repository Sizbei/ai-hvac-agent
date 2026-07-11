import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state ──────────────────────────────────────────────────────
interface CapturedQuery {
  where: unknown;
  hasLimit: boolean;
  orderBy?: unknown;
  groupBy?: unknown;
  selectCols?: unknown;
}

const { selectQueue, captured, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const captured: CapturedQuery[] = [];

  const chain = (resolved: unknown, capture: CapturedQuery): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(resolved);
        }
        if (prop === 'where') {
          return (cond: unknown) => {
            capture.where = cond;
            return p;
          };
        }
        if (prop === 'limit') {
          return () => {
            capture.hasLimit = true;
            return p;
          };
        }
        if (prop === 'orderBy') {
          return (expr: unknown) => {
            capture.orderBy = expr;
            return p;
          };
        }
        if (prop === 'groupBy') {
          return (expr: unknown) => {
            capture.groupBy = expr;
            return p;
          };
        }
        // offset, from, leftJoin — all return same proxy
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };

  return { selectQueue, captured, chain };
});

vi.mock('@/lib/db', () => {
  const make = (cols?: unknown) => {
    const capture: CapturedQuery = { where: undefined, hasLimit: false, selectCols: cols };
    captured.push(capture);
    return chain(selectQueue.shift() ?? [], capture);
  };
  return { db: { select: make, selectDistinct: make } };
});

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, orgId: string, ...conditions: unknown[]) => [
    { kind: 'tenant', orgId },
    ...conditions,
  ],
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: (s: string) => s,
}));

vi.mock('server-only', () => ({}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ({ kind: 'eq', args: a }),
  or: (...a: unknown[]) => ({ kind: 'or', args: a }),
  ilike: (...a: unknown[]) => ({ kind: 'ilike', args: a }),
  asc: (c: unknown) => ({ kind: 'asc', col: c }),
  desc: (c: unknown) => ({ kind: 'desc', col: c }),
  count: () => ({ kind: 'count' }),
  and: (...a: unknown[]) => ({ kind: 'and', args: a }),
  isNull: (c: unknown) => ({ kind: 'isNull', col: c }),
  isNotNull: (c: unknown) => ({ kind: 'isNotNull', col: c }),
  inArray: (...a: unknown[]) => ({ kind: 'inArray', args: a }),
  gte: (...a: unknown[]) => ({ kind: 'gte', args: a }),
  lt: (...a: unknown[]) => ({ kind: 'lt', args: a }),
  sum: (c: unknown) => ({ kind: 'sum', col: c }),
  sql: vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({
    kind: 'sql',
    text: strings.join('?'),
    vals,
  })),
}));

vi.mock('@/lib/db/schema', () => ({
  invoices: {
    id: 'inv.id',
    organizationId: 'inv.org',
    state: 'inv.state',
    totalCents: 'inv.totalCents',
    amountPaidCents: 'inv.amountPaidCents',
    customerId: 'inv.customerId',
    serviceRequestId: 'inv.serviceRequestId',
    createdAt: 'inv.createdAt',
    issuedAt: 'inv.issuedAt',
    dueDate: 'inv.dueDate',
    lastReminderSentAt: 'inv.lastReminderSentAt',
    fieldpulseInvoiceId: 'inv.fpInvoiceId',
    hcpInvoiceId: 'inv.hcpInvoiceId',
    fieldpulseData: 'inv.fpData',
    subtotalCents: 'inv.subtotalCents',
    taxCents: 'inv.taxCents',
    updatedAt: 'inv.updatedAt',
    estimateId: 'inv.estimateId',
  },
  customers: {
    id: 'cust.id',
    organizationId: 'cust.org',
    nameEncrypted: 'cust.nameEncrypted',
    archivedAt: 'cust.archivedAt',
  },
  payments: {
    id: 'pay.id',
    organizationId: 'pay.org',
    amountCents: 'pay.amountCents',
    status: 'pay.status',
    createdAt: 'pay.createdAt',
    fieldpulsePaymentId: 'pay.fpPaymentId',
  },
  invoiceStateEnum: { enumValues: ['draft', 'open', 'paid', 'void', 'refunded'] },
}));

// Mock other modules that invoice-queries.ts imports
vi.mock('@/lib/payments/provider', () => ({
  getPaymentProvider: vi.fn(),
}));
vi.mock('@/lib/admin/margin', () => ({
  rollUpActualMaterialsCost: vi.fn(),
  rollUpActualLaborCost: vi.fn(),
}));
vi.mock('@/lib/admin/org-config-types', () => ({
  businessInfoSchema: { parse: (v: unknown) => v },
}));
vi.mock('@/lib/admin/invoice-collectible', () => ({
  invoiceRef: (id: string) => `#${id.slice(0, 8).toUpperCase()}`,
  REMINDER_COOLDOWN_MS: 0,
  canResend: () => true,
}));

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

import { getInvoiceSummaryStats, listInvoices } from './invoice-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

// ── Test (a): stats SQL WHERE contains state='open' AND total>paid ────────────
describe('getInvoiceSummaryStats', () => {
  it('(a) stats SQL WHERE includes state=open and total>paid conditions', async () => {
    selectQueue.push([{
      outstandingCents: '0',
      outstandingCount: 0,
      overdueCents: '0',
      overdueCount: 0,
    }]);
    const result = await getInvoiceSummaryStats(ORG);
    expect(captured.length).toBe(1);
    const where = JSON.stringify(captured[0]?.where ?? '');
    // must contain tenant scope
    expect(where).toContain(ORG);
    // must contain eq(state, 'open')
    expect(where).toContain('inv.state');
    // must contain a sql`` predicate (total > paid)
    expect(where).toContain('"kind":"sql"');
    // result shape
    expect(result).toHaveProperty('outstandingCents');
    expect(result).toHaveProperty('outstandingCount');
    expect(result).toHaveProperty('overdueCents');
    expect(result).toHaveProperty('overdueCount');
  });

  it('wraps bigint string values with Number()', async () => {
    selectQueue.push([{
      outstandingCents: '15206100',
      outstandingCount: 119,
      overdueCents: '5000000',
      overdueCount: 30,
    }]);
    const result = await getInvoiceSummaryStats(ORG);
    expect(typeof result.outstandingCents).toBe('number');
    expect(result.outstandingCents).toBe(15206100);
    expect(result.overdueCount).toBe(30);
  });
});

// ── Test (b): page query carries LIMIT ───────────────────────────────────────
describe('listInvoices', () => {
  // listInvoices creates 3 db.select() calls in this order:
  //   [0] sourceCountsPromise (db.select first in code)
  //   [1] countPromise
  //   [2] rowsPromise (with leftJoin)
  const queueListPage = (rows: unknown[] = []) => {
    // sourceCountsPromise (first db.select call in the function)
    selectQueue.push([
      { source: 'native', n: 0 },
      { source: 'fieldpulse', n: 2851 },
    ]);
    // countPromise
    selectQueue.push([{ n: 2851 }]);
    // page rows
    selectQueue.push(rows);
  };

  it('(b) page query carries a LIMIT', async () => {
    queueListPage();
    await listInvoices(ORG);
    expect(captured.some((c) => c.hasLimit)).toBe(true);
  });

  it('returns { invoices, total, sourceCounts } shape', async () => {
    queueListPage([{ id: 'inv-1', state: 'open', totalCents: 10000, amountPaidCents: 0, customerId: null, serviceRequestId: null, createdAt: new Date(), issuedAt: null, dueDate: null, lastReminderSentAt: null, fieldpulseInvoiceId: null, hcpInvoiceId: null, nameEncrypted: null, fieldpulseData: null }]);
    const result = await listInvoices(ORG);
    expect(result).toHaveProperty('invoices');
    expect(result).toHaveProperty('total', 2851);
    expect(result).toHaveProperty('sourceCounts');
  });

  it('(c) fetch-all-rows and sourceCounts share base WHERE under search; source filter absent from facet', async () => {
    // Search path: 4 db.select() calls in order:
    //   [0] sourceCountsPromise  (whereClauseNoSource — no source predicates)
    //   [1] countPromise         (whereClause — created but not awaited in search path)
    //   [2] rowsPromise          (whereClause — created but not awaited in search path)
    //   [3] allRowsPromise       (whereClause — fetch-all for search+decrypt)
    selectQueue.push([{ source: 'native', n: 0 }, { source: 'fieldpulse', n: 1 }]); // [0] sourceCounts
    selectQueue.push([{ n: 0 }]); // [1] count (unused in search path)
    selectQueue.push([]); // [2] rows (unused in search path)
    selectQueue.push([]); // [3] allRows for search
    await listInvoices(ORG, { state: 'open', search: 'test' });

    // All 4 queries must be tenant-scoped.
    const allWheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(allWheres.every((w) => w.includes(ORG))).toBe(true);

    // The fetch-all-rows query (captured[3]) and count (captured[1]) must include state filter.
    const allRowsWhere = JSON.stringify(captured[3]?.where ?? '');
    const countWhere = JSON.stringify(captured[1]?.where ?? '');
    expect(allRowsWhere).toContain('inv.state');
    expect(countWhere).toContain('inv.state');

    // Critical 2 regression guard: sourceCounts (captured[0]) WHERE must NOT contain
    // source predicates even when source filter is active in the main query.
    // Re-run with source='fieldpulse' to exercise the guard.
    captured.length = 0;
    selectQueue.push([{ source: 'native', n: 5 }, { source: 'fieldpulse', n: 3 }]); // [0] sourceCounts
    selectQueue.push([{ n: 0 }]); // [1] count
    selectQueue.push([]); // [2] rows
    selectQueue.push([]); // [3] allRows
    await listInvoices(ORG, { state: 'open', source: 'fieldpulse', search: 'test' });

    const sourceCountsWhere = JSON.stringify(captured[0]?.where ?? '');
    const mainRowsWhere = JSON.stringify(captured[3]?.where ?? '');

    // Facet WHERE must NOT contain any isNotNull/isNull on source id columns.
    expect(sourceCountsWhere).not.toMatch(/"kind":"isNotNull"/);
    expect(sourceCountsWhere).not.toMatch(/"kind":"isNull"/);

    // Rows WHERE must contain the source predicate (isNotNull for fieldpulse).
    expect(mainRowsWhere).toContain('"kind":"isNotNull"');
    expect(mainRowsWhere).toContain('fpInvoiceId');

    // Critical 1 regression guard: sourceCountsPromise must have groupBy set.
    expect(captured[0]?.groupBy).toBeDefined();
  });

  it('(d) source filter "native" produces both-ids-NULL predicates', async () => {
    queueListPage();
    await listInvoices(ORG, { source: 'native' });
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    // the native filter: both fieldpulse and hcp ids must be IS NULL
    const hasNullFp = wheres.some((w) => w.includes('"kind":"isNull"') && w.includes('fpInvoiceId'));
    const hasNullHcp = wheres.some((w) => w.includes('"kind":"isNull"') && w.includes('hcpInvoiceId'));
    expect(hasNullFp).toBe(true);
    expect(hasNullHcp).toBe(true);
  });

  it('is tenant-scoped: every query WHERE includes the org id', async () => {
    queueListPage();
    await listInvoices(ORG);
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(wheres.every((w) => w.includes(ORG))).toBe(true);
  });

  // ── sort param tests ──────────────────────────────────────────────────────

  it('(e) sort=newest produces DESC orderBy on rows query', async () => {
    queueListPage();
    await listInvoices(ORG, { sort: 'newest' });
    // captured[2] is the rows query (index 0=sourceCounts, 1=count, 2=rows)
    const rowsOrderBy = JSON.stringify(captured[2]?.orderBy ?? '');
    expect(rowsOrderBy).toContain('"kind":"desc"');
  });

  it('(f) sort=oldest produces ASC orderBy on rows query', async () => {
    queueListPage();
    await listInvoices(ORG, { sort: 'oldest' });
    const rowsOrderBy = JSON.stringify(captured[2]?.orderBy ?? '');
    expect(rowsOrderBy).toContain('"kind":"asc"');
  });

  it('(g) sort=balance-high produces DESC orderBy on rows query', async () => {
    queueListPage();
    await listInvoices(ORG, { sort: 'balance-high' });
    const rowsOrderBy = JSON.stringify(captured[2]?.orderBy ?? '');
    expect(rowsOrderBy).toContain('"kind":"desc"');
  });

  it('(h) sort=age-oldest produces DESC orderBy on rows query', async () => {
    queueListPage();
    await listInvoices(ORG, { sort: 'age-oldest' });
    const rowsOrderBy = JSON.stringify(captured[2]?.orderBy ?? '');
    expect(rowsOrderBy).toContain('"kind":"desc"');
  });

  // ── overdue filter tests ──────────────────────────────────────────────────

  it('(i) overdue=true adds overdue sql predicate to WHERE in count and rows queries', async () => {
    queueListPage();
    await listInvoices(ORG, { state: 'open', overdue: true });
    // captured[1]=count, [2]=rows — both must carry the overdue sql fragment
    const countWhere = JSON.stringify(captured[1]?.where ?? '');
    const rowsWhere = JSON.stringify(captured[2]?.where ?? '');
    // The overdue predicate uses sql`` tagged template containing 'dueDate' column refs
    // The mock sql() produces { kind:'sql', text, vals } — look for dueDate references
    expect(countWhere).toContain('"kind":"sql"');
    expect(rowsWhere).toContain('"kind":"sql"');
    // Both queries must also have the tenant org in WHERE
    expect(countWhere).toContain(ORG);
    expect(rowsWhere).toContain(ORG);
  });

  it('(j) overdue=false (default) does not add the dueDate overdue predicate to WHERE', async () => {
    queueListPage();
    await listInvoices(ORG, { state: 'open' });
    const countWhere = JSON.stringify(captured[1]?.where ?? '');
    // Without the overdue flag, the dueDate-specific overdue fragment must be absent.
    // The overdue predicate always contains 'dueDate' column refs in its sql text.
    expect(countWhere).toContain('inv.state');
    expect(countWhere).not.toContain('inv.dueDate');
  });
});
