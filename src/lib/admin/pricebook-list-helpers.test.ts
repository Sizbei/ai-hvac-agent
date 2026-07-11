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
  return { db: { select: make, selectDistinct: make } };
});

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, orgId: string, ...conditions: unknown[]) => [
    { kind: 'tenant', orgId },
    ...conditions,
  ],
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ({ kind: 'eq', args: a }),
  or: (...a: unknown[]) => ({ kind: 'or', args: a }),
  ilike: (...a: unknown[]) => ({ kind: 'ilike', args: a }),
  asc: (c: unknown) => ({ kind: 'asc', col: c }),
  count: () => 'count',
  and: (...a: unknown[]) => ({ kind: 'and', args: a }),
  sql: vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({
    kind: 'sql',
    text: strings.join('?'),
    vals,
  })),
}));

vi.mock('@/lib/db/schema', () => ({
  pricebookItems: {
    id: 'pb.id',
    organizationId: 'pb.org',
    type: 'pb.type',
    name: 'pb.name',
    sku: 'pb.sku',
    description: 'pb.description',
    categoryId: 'pb.categoryId',
    costCents: 'pb.costCents',
    markupPct: 'pb.markupPct',
    priceCents: 'pb.priceCents',
    memberPriceCents: 'pb.memberPriceCents',
    hours: 'pb.hours',
    warranty: 'pb.warranty',
    active: 'pb.active',
    isLaborItem: 'pb.isLaborItem',
    fieldpulseItemId: 'pb.fpItemId',
    fieldpulseData: 'pb.fpData',
  },
  taxRates: {},
}));

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

import { listPricebookItemsForAdmin } from './pricebook-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

// Three queries run in Promise.all: selectDistinct (types), count, page rows.
const queuePage = (rows: unknown[] = []) => {
  selectQueue.push([{ type: 'service' }]); // selectDistinct types
  selectQueue.push([{ n: 42 }]);           // COUNT
  selectQueue.push(rows);                  // page rows
};

describe('listPricebookItemsForAdmin', () => {
  it('paginates: page query carries a LIMIT', async () => {
    queuePage();
    await listPricebookItemsForAdmin(ORG);
    expect(captured.some((c) => c.hasLimit)).toBe(true);
  });

  it('is tenant-scoped: every query WHERE includes the org id', async () => {
    queuePage();
    await listPricebookItemsForAdmin(ORG);
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(wheres.every((w) => w.includes(ORG))).toBe(true);
  });

  it('returns { items, total, types } shape', async () => {
    queuePage([{ id: 'item-1', name: 'Part A' }]);
    const result = await listPricebookItemsForAdmin(ORG);
    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('total', 42);
    expect(result).toHaveProperty('types');
    expect(Array.isArray(result.types)).toBe(true);
  });

  it('filters by active=true by default (an eq predicate on pb.active)', async () => {
    queuePage();
    await listPricebookItemsForAdmin(ORG);
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(
      wheres.some((w) => w.includes('"kind":"eq"') && w.includes('pb.active')),
    ).toBe(true);
  });

  it('applies ilike search on name/sku/description when search is provided', async () => {
    queuePage();
    await listPricebookItemsForAdmin(ORG, { search: 'compressor' });
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(
      wheres.some((w) => w.includes('"kind":"ilike"')),
    ).toBe(true);
  });

  it('applies type equality filter when type is provided', async () => {
    queuePage();
    await listPricebookItemsForAdmin(ORG, { type: 'service' });
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    // type filter uses a sql`` template (to bypass enum literal constraint)
    expect(
      wheres.some((w) => w.includes('"kind":"sql"') && w.includes('service')),
    ).toBe(true);
  });

  it('uses selectDistinct for the types facet', async () => {
    queuePage([{ type: 'service' }]);
    const result = await listPricebookItemsForAdmin(ORG);
    // selectDistinct fires as one of our three captured queries
    expect(captured.length).toBe(3);
    expect(result.types).toEqual(['service']);
  });

  it('count query and rows query share the same WHERE when search is active', async () => {
    queuePage();
    await listPricebookItemsForAdmin(ORG, { search: 'filter' });
    // captured[0] = selectDistinct (types facet), [1] = count, [2] = rows
    const countWhere = JSON.stringify(captured[1]?.where ?? '');
    const rowsWhere = JSON.stringify(captured[2]?.where ?? '');
    expect(countWhere).toBe(rowsWhere);
    // Both must mention the search term in some form (ilike was applied)
    expect(countWhere).toContain('"kind":"ilike"');
  });

  it('escapes LIKE metacharacters in search input', async () => {
    queuePage();
    await listPricebookItemsForAdmin(ORG, { search: 'comp%res_sor\\' });
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    const withIlike = wheres.find((w) => w.includes('"kind":"ilike"')) ?? '';
    // percent, underscore, and backslash must all be escaped
    expect(withIlike).toContain('\\%');
    expect(withIlike).toContain('\\_');
    expect(withIlike).toContain('\\\\');
  });
});
