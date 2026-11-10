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

// withTenant returns a tagged array so tests can inspect the org filter and
// extra conditions separately.
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, orgId: string, ...conditions: unknown[]) => [
    { kind: 'tenant', orgId },
    ...conditions,
  ],
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ({ kind: 'eq', args: a }),
  and: (...a: unknown[]) => ({ kind: 'and', args: a }),
  ne: (...a: unknown[]) => ({ kind: 'ne', args: a }),
  desc: (c: unknown) => ({ kind: 'desc', col: c }),
  count: () => 'count',
  isNull: (c: unknown) => ({ kind: 'isNull', c }),
  isNotNull: (c: unknown) => ({ kind: 'isNotNull', c }),
  inArray: (c: unknown, v: unknown) => ({ kind: 'inArray', c, v }),
  sql: vi.fn((strings: TemplateStringsArray) => ({ kind: 'sql', text: strings.join('?') })),
}));

vi.mock('@/lib/db/schema', () => ({
  customers: {
    id: 'customers.id',
    organizationId: 'customers.org',
    nameEncrypted: 'customers.name',
    emailEncrypted: 'customers.email',
    phoneEncrypted: 'customers.phone',
    addressEncrypted: 'customers.address',
    propertyType: 'customers.pt',
    propertySqft: 'customers.sqft',
    notes: 'customers.notes',
    createdAt: 'customers.createdAt',
    updatedAt: 'customers.updated',
    archivedAt: 'customers.archived',
    anonymizedAt: 'customers.anonymized',
    customerType: 'customers.customerType',
    membershipStatus: 'customers.membershipStatus',
    fieldpulseCustomerId: 'customers.fieldpulseCustomerId',
  },
  customerEquipment: { id: 'equip.id', customerId: 'equip.cid', organizationId: 'equip.org' },
  customerNotes: { id: 'notes.id', customerId: 'notes.cid' },
  followUps: { id: 'fu.id', customerId: 'fu.cid', status: 'fu.status' },
  serviceHistory: { id: 'sh.id', customerId: 'sh.cid', serviceRequestId: 'sh.srid' },
  serviceRequests: { customerId: 'sr.cid', id: 'sr.id', sessionId: 'sr.sid', completedAt: 'sr.completedAt', createdAt: 'sr.createdAt', status: 'sr.status' },
  users: { id: 'users.id', name: 'users.name' },
  auditLog: {},
  customerTypeEnum: { enumValues: ['residential', 'commercial'] },
  membershipStatusEnum: { enumValues: ['none', 'active', 'suspended', 'expired', 'cancelled'] },
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

import { getCustomers } from './crm-queries';
import { VISIBLE_ONLY } from './visibility';

const ORG = '00000000-0000-0000-0000-000000000001';

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'c1',
  nameEncrypted: 'enc:Alice',
  phoneEncrypted: null,
  emailEncrypted: null,
  addressEncrypted: null,
  propertyType: 'residential',
  propertySqft: null,
  notes: null,
  createdAt: new Date('2026-01-01'),
  customerType: 'residential',
  membershipStatus: 'none',
  fieldpulseCustomerId: null,
  archivedAt: null,
  equipmentCount: 0,
  requestCount: 0,
  lastServiceDate: null,
  ...overrides,
});

describe('getCustomers', () => {
  // The paginated query issues three statements: distinct property types, a
  // COUNT for the total, and the page itself. Queue rows in that order; assert
  // across all captured wheres rather than a fixed index.
  const queuePage = () => {
    selectQueue.push([]); // distinct property types
    selectQueue.push([{ value: 1 }]); // COUNT
    selectQueue.push([makeRow()]); // page rows
  };
  // Some queries (the outer aggregate join) carry no WHERE — coalesce so
  // JSON.stringify always yields a string.
  const wheres = () => captured.map((c) => JSON.stringify(c.where ?? ''));

  it('excludes archived rows by default: an isNull(archivedAt) predicate is applied', async () => {
    queuePage();
    await getCustomers(ORG, {}, VISIBLE_ONLY);
    const all = wheres();
    expect(
      all.some(
        (w) => w.includes('"kind":"isNull"') && w.includes('customers.archived'),
      ),
    ).toBe(true);
    expect(all.some((w) => w.includes(ORG))).toBe(true);
  });

  it('includes archived rows when includeArchived=true: no isNull(archivedAt) predicate', async () => {
    queuePage();
    await getCustomers(ORG, { includeArchived: true }, VISIBLE_ONLY);
    const all = wheres();
    // isNotNull(propertyType) on the distinct query is fine; the archived
    // isNull predicate must be absent.
    expect(all.some((w) => w.includes('"kind":"isNull"'))).toBe(false);
    expect(all.some((w) => w.includes(ORG))).toBe(true);
  });

  it('paginates: applies a LIMIT on the page query (no-search path)', async () => {
    queuePage();
    await getCustomers(ORG, {}, VISIBLE_ONLY);
    expect(captured.some((c) => c.hasLimit)).toBe(true);
  });

  it('hides erased rows by default and shows them with includeArchived', async () => {
    queuePage();
    await getCustomers(ORG, {}, VISIBLE_ONLY);
    expect(wheres().some((w) => w.includes('customers.anonymized'))).toBe(true);

    captured.length = 0;
    queuePage();
    await getCustomers(ORG, { includeArchived: true }, VISIBLE_ONLY);
    expect(wheres().some((w) => w.includes('customers.anonymized'))).toBe(false);
  });

  describe('search', () => {
    const queueSearch = (fp: string, scan: unknown[], pageRows: unknown[]) => {
      selectQueue.push([]); // distinct property types
      selectQueue.push([{ fp }]); // fingerprint
      if (scan.length || fp) selectQueue.push(scan); // scan (skipped on a cache hit)
      selectQueue.push(pageRows); // page aggregate
    };
    const scanRow = (id: string, phone: string) => ({
      id,
      nameEncrypted: `enc:Name ${id}`,
      phoneEncrypted: `enc:${phone}`,
      emailEncrypted: null,
      addressEncrypted: null,
    });

    it.each(['423-555-0187', '4235550187', '(423) 555-0187'])(
      'matches a formatted phone typed as %s',
      async (q) => {
        queueSearch(`fp-${q}`, [scanRow('a', '(423) 555-0187'), scanRow('b', '(423) 555-0144')], [
          makeRow({ id: 'a', phoneEncrypted: 'enc:(423) 555-0187' }),
        ]);
        const res = await getCustomers(ORG, { search: q }, VISIBLE_ONLY);
        expect(res.total).toBe(1);
        expect(res.customers.map((c) => c.id)).toEqual(['a']);
      },
    );

    it('reuses the cached scan when the fingerprint is unchanged', async () => {
      const opts = { search: '0144', customerType: 'commercial' };
      queueSearch('fp-cache', [scanRow('b', '(423) 555-0144')], [makeRow({ id: 'b' })]);
      await getCustomers(ORG, opts, VISIBLE_ONLY);
      const firstQueries = captured.length;

      captured.length = 0;
      selectQueue.push([]); // types
      selectQueue.push([{ fp: 'fp-cache' }]); // same fingerprint → no scan
      selectQueue.push([makeRow({ id: 'b' })]); // page aggregate
      const res = await getCustomers(ORG, opts, VISIBLE_ONLY);
      expect(captured.length).toBe(firstQueries - 1);
      expect(res.customers.map((c) => c.id)).toEqual(['b']);
    });

    it('returns an empty page without an aggregate query when nothing matches', async () => {
      selectQueue.push([]);
      selectQueue.push([{ fp: 'fp-none' }]);
      selectQueue.push([scanRow('a', '(423) 555-0187')]);
      const res = await getCustomers(ORG, { search: 'zzzzqqq' }, VISIBLE_ONLY);
      expect(res).toEqual({ customers: [], total: 0, propertyTypes: [] });
      expect(captured.length).toBe(3);
    });
  });
});
