import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state ──────────────────────────────────────────────────────
interface CapturedQuery {
  where: unknown;
  hasLimit: boolean;
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
        if (prop === 'leftJoin') { return () => p; }
        if (prop === 'orderBy') { return () => p; }
        if (prop === 'offset') { return () => p; }
        // from, select, etc. — all return same proxy
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };

  return { selectQueue, captured, chain };
});

vi.mock('@/lib/db', () => {
  const make = () => {
    const capture: CapturedQuery = { where: undefined, hasLimit: false };
    captured.push(capture);
    return chain(selectQueue.shift() ?? [], capture);
  };
  return { db: { select: make } };
});

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, orgId: string, ...conditions: unknown[]) => [
    { kind: 'tenant', orgId },
    ...conditions,
  ],
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ({ kind: 'eq', args: a }),
  and: (...a: unknown[]) => ({ kind: 'and', args: a }),
  asc: (c: unknown) => ({ kind: 'asc', col: c }),
  desc: (c: unknown) => ({ kind: 'desc', col: c }),
  count: () => 'count',
  inArray: (...a: unknown[]) => ({ kind: 'inArray', args: a }),
  isNull: (c: unknown) => ({ kind: 'isNull', col: c }),
  sql: vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({
    kind: 'sql',
    text: strings.join('?'),
    vals,
  })),
}));

vi.mock('@/lib/db/schema', () => ({
  estimates: {
    id: 'est.id',
    organizationId: 'est.org',
    status: 'est.status',
    totalCents: 'est.totalCents',
    customerId: 'est.customerId',
    serviceRequestId: 'est.serviceRequestId',
    createdAt: 'est.createdAt',
    expiresAt: 'est.expiresAt',
    signedAt: 'est.signedAt',
    fieldpulseEstimateId: 'est.fpEstId',
    fieldpulseStatusName: 'est.fpStatusName',
    title: 'est.title',
    fieldpulseData: 'est.fpData',
    approvalTokenHash: 'est.approvalTokenHash',
    soldOptionId: 'est.soldOptionId',
    signatureName: 'est.signatureName',
    signatureIp: 'est.signatureIp',
    dueDate: 'est.dueDate',
    updatedAt: 'est.updatedAt',
  },
  estimateOptions: {
    id: 'eo.id',
    organizationId: 'eo.org',
    estimateId: 'eo.estimateId',
    name: 'eo.name',
    sortOrder: 'eo.sortOrder',
    subtotalCents: 'eo.subtotalCents',
    taxCents: 'eo.taxCents',
    totalCents: 'eo.totalCents',
  },
  estimateLineItems: {
    id: 'eli.id',
    organizationId: 'eli.org',
    optionId: 'eli.optionId',
    pricebookItemId: 'eli.pricebookItemId',
    name: 'eli.name',
    quantity: 'eli.quantity',
    unitPriceCents: 'eli.unitPriceCents',
    costCents: 'eli.costCents',
    lineTotalCents: 'eli.lineTotalCents',
  },
  customers: {
    id: 'customers.id',
    organizationId: 'customers.organizationId',
    nameEncrypted: 'customers.nameEncrypted',
  },
}));

// Also mock the money helper that estimate-queries imports
vi.mock('@/lib/admin/money', () => ({
  computeOptionTotals: vi.fn(() => ({ subtotalCents: 0, taxCents: 0, totalCents: 0 })),
  lineTotalCents: vi.fn(() => 0),
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: (ct: string) => ct,
}));

vi.mock('server-only', () => ({}));

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

import { listEstimates, getEstimatePipelineStats } from './estimate-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

// Two selects per listEstimates call: count then page rows.
const queuePage = (rows: unknown[] = []) => {
  selectQueue.push([{ n: 10 }]); // COUNT
  selectQueue.push(rows);         // page rows
};

describe('listEstimates', () => {
  it('paginates: page query carries a LIMIT', async () => {
    queuePage();
    await listEstimates(ORG);
    expect(captured.some((c) => c.hasLimit)).toBe(true);
  });

  it('is tenant-scoped: every WHERE includes the org id', async () => {
    queuePage();
    await listEstimates(ORG);
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(wheres.every((w) => w.includes(ORG))).toBe(true);
  });

  it('returns { estimates, total } shape', async () => {
    queuePage([{ id: 'est-1', status: 'open', totalCents: 10000, customerId: null, serviceRequestId: null, createdAt: new Date(), expiresAt: null, signedAt: null, fieldpulseEstimateId: null, fieldpulseStatusName: null, title: null, fieldpulseData: null }]);
    const result = await listEstimates(ORG);
    expect(result).toHaveProperty('estimates');
    expect(result).toHaveProperty('total', 10);
    expect(Array.isArray(result.estimates)).toBe(true);
  });

  it('count and rows queries share the same WHERE', async () => {
    queuePage();
    await listEstimates(ORG);
    // captured[0] = count query, captured[1] = rows query
    const countWhere = JSON.stringify(captured[0]?.where ?? '');
    const rowsWhere = JSON.stringify(captured[1]?.where ?? '');
    expect(countWhere).toBe(rowsWhere);
  });

  it('applies customerId filter when provided', async () => {
    queuePage();
    await listEstimates(ORG, { customerId: 'cid-1' });
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(
      wheres.some((w) => w.includes('"kind":"eq"') && w.includes('est.customerId')),
    ).toBe(true);
  });

  it('applies serviceRequestId filter when provided', async () => {
    queuePage();
    await listEstimates(ORG, { serviceRequestId: 'sr-1' });
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(
      wheres.some((w) => w.includes('"kind":"eq"') && w.includes('est.serviceRequestId')),
    ).toBe(true);
  });

  it('bucket=open applies LIMIT', async () => {
    queuePage();
    await listEstimates(ORG, { bucket: 'open' });
    expect(captured.some((c) => c.hasLimit)).toBe(true);
  });

  it('bucket=open includes open-bucket predicate in WHERE', async () => {
    queuePage();
    await listEstimates(ORG, { bucket: 'open' });
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(wheres.some((w) => w.includes('open'))).toBe(true);
  });

  it('bucket=won includes won-bucket predicate in WHERE', async () => {
    queuePage();
    await listEstimates(ORG, { bucket: 'won' });
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(wheres.some((w) => w.includes('won'))).toBe(true);
  });

  it('count and rows queries share tenant org with bucket filter', async () => {
    queuePage();
    await listEstimates(ORG, { bucket: 'open' });
    const countWhere = JSON.stringify(captured[0]?.where ?? '');
    const rowsWhere = JSON.stringify(captured[1]?.where ?? '');
    expect(countWhere).toBe(rowsWhere);
  });
});

describe('getEstimatePipelineStats', () => {
  it('is tenant-scoped', async () => {
    selectQueue.push([{
      openCents: 0, openCount: 0, staleCents: 0, staleCount: 0,
      wonCents: 0, wonCount: 0, lostCents: 0, lostCount: 0,
      draftCents: 0, draftCount: 0, winRatePct: null, avgOpenAgeDays: 0,
    }]);
    await getEstimatePipelineStats(ORG);
    const whereStr = JSON.stringify(captured[0]?.where ?? '');
    expect(whereStr).toContain(ORG);
  });

  it('returns numeric stats shape', async () => {
    selectQueue.push([{
      openCents: '5000', openCount: '3', staleCents: '1000', staleCount: '1',
      wonCents: '20000', wonCount: '5', lostCents: '3000', lostCount: '2',
      draftCents: '0', draftCount: '0', winRatePct: '71', avgOpenAgeDays: '7',
    }]);
    const stats = await getEstimatePipelineStats(ORG);
    expect(typeof stats.openCents).toBe('number');
    expect(typeof stats.wonCents).toBe('number');
    expect(stats.winRatePct).toBe(71);
  });

  it('winRatePct is null when no won or lost estimates', async () => {
    selectQueue.push([{
      openCents: 0, openCount: 0, staleCents: 0, staleCount: 0,
      wonCents: 0, wonCount: 0, lostCents: 0, lostCount: 0,
      draftCents: 0, draftCount: 0, winRatePct: null, avgOpenAgeDays: 0,
    }]);
    const stats = await getEstimatePipelineStats(ORG);
    expect(stats.winRatePct).toBeNull();
  });
});

describe('listEstimates bucket filter', () => {
  it('bucket=open applies limit', async () => {
    selectQueue.push([{ n: 0 }]);
    selectQueue.push([]);
    await listEstimates('org-x', { bucket: 'open' });
    const rowQuery = captured[captured.length - 1];
    expect(rowQuery.hasLimit).toBe(true);
  });

  it('bucket=open includes open-bucket predicate in WHERE', async () => {
    selectQueue.push([{ n: 0 }]);
    selectQueue.push([]);
    await listEstimates('org-x', { bucket: 'open' });
    const rowQuery = captured[captured.length - 1];
    const whereStr = JSON.stringify(rowQuery.where);
    expect(whereStr).toContain('open');
  });

  it('bucket=won includes won-bucket predicate in WHERE', async () => {
    selectQueue.push([{ n: 0 }]);
    selectQueue.push([]);
    await listEstimates('org-x', { bucket: 'won' });
    const rowQuery = captured[captured.length - 1];
    const whereStr = JSON.stringify(rowQuery.where);
    expect(whereStr).toContain('won');
  });

  it('count and rows queries share tenant org in WHERE', async () => {
    selectQueue.push([{ n: 0 }]);
    selectQueue.push([]);
    await listEstimates('org-shared', {});
    const countQ = captured[captured.length - 2];
    const rowQ = captured[captured.length - 1];
    expect(JSON.stringify(countQ.where)).toContain('org-shared');
    expect(JSON.stringify(rowQ.where)).toContain('org-shared');
  });
});
