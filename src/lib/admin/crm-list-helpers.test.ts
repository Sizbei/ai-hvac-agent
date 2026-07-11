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
    customerType: 'customers.customerType',
    membershipStatus: 'customers.membershipStatus',
    fieldpulseCustomerId: 'customers.fieldpulseCustomerId',
  },
  customerEquipment: { id: 'equip.id', customerId: 'equip.cid', organizationId: 'equip.org' },
  customerNotes: { id: 'notes.id', customerId: 'notes.cid' },
  followUps: { id: 'fu.id', customerId: 'fu.cid', status: 'fu.status' },
  serviceHistory: { id: 'sh.id', customerId: 'sh.cid', serviceRequestId: 'sh.srid' },
  serviceRequests: { customerId: 'sr.cid', id: 'sr.id', sessionId: 'sr.sid' },
  users: { id: 'users.id', name: 'users.name' },
  auditLog: {},
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

import { getCustomers } from './crm-queries';

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
    await getCustomers(ORG);
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
    await getCustomers(ORG, { includeArchived: true });
    const all = wheres();
    // isNotNull(propertyType) on the distinct query is fine; the archived
    // isNull predicate must be absent.
    expect(all.some((w) => w.includes('"kind":"isNull"'))).toBe(false);
    expect(all.some((w) => w.includes(ORG))).toBe(true);
  });

  it('paginates: applies a LIMIT on the page query (no-search path)', async () => {
    queuePage();
    await getCustomers(ORG);
    expect(captured.some((c) => c.hasLimit)).toBe(true);
  });
});
