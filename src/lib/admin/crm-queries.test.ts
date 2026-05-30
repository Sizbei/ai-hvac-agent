import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state ─────────────────────────────────────────────
const { selectQueue, batchMock, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const batchMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  // Chainable thenable proxy: every method returns itself; awaiting resolves
  // to the value provided at construction time.
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(resolved);
        }
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return { selectQueue, batchMock, chain };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    delete: () => chain([]),
    insert: () => chain([]),
    update: () => chain([]),
    batch: (...args: unknown[]) => batchMock(...args),
  },
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, _orgId: string, ...conditions: unknown[]) =>
    conditions[0] ?? true,
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => a,
  and: (...a: unknown[]) => a,
  desc: (c: unknown) => c,
  asc: (c: unknown) => c,
  count: () => 'count',
  max: (c: unknown) => c,
  sql: vi.fn(),
  inArray: (...a: unknown[]) => a,
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
    createdAt: 'customers.created',
  },
  customerEquipment: { customerId: 'equip.cid' },
  customerNotes: { customerId: 'notes.cid' },
  followUps: { customerId: 'fu.cid' },
  serviceHistory: { customerId: 'sh.cid', serviceRequestId: 'sh.srid' },
  serviceRequests: { customerId: 'sr.cid', id: 'sr.id', sessionId: 'sr.sid' },
  users: { id: 'users.id', name: 'users.name' },
  auditLog: {},
}));

import { findCustomerIdByContact, deleteCustomer } from './crm-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  selectQueue.length = 0;
  batchMock.mockClear();
  batchMock.mockResolvedValue([]);
});

describe('findCustomerIdByContact', () => {
  it('returns null without querying when both email and phone are empty', async () => {
    const result = await findCustomerIdByContact(ORG, {
      email: null,
      phone: null,
    });
    expect(result).toBeNull();
    // No select consumed — the queue is untouched.
    expect(selectQueue.length).toBe(0);
  });

  it('matches an existing customer by email (case-insensitive)', async () => {
    selectQueue.push([
      { id: 'c1', emailEncrypted: 'enc:alice@example.com', phoneEncrypted: null },
      { id: 'c2', emailEncrypted: 'enc:bob@example.com', phoneEncrypted: null },
    ]);
    const result = await findCustomerIdByContact(ORG, {
      email: 'BOB@Example.com',
      phone: null,
    });
    expect(result).toBe('c2');
  });

  it('falls back to phone when an email is supplied but does not match (regression: the old continue skipped this)', async () => {
    selectQueue.push([
      {
        id: 'c1',
        emailEncrypted: 'enc:alice@example.com',
        phoneEncrypted: 'enc:(555) 010-0100',
      },
    ]);
    const result = await findCustomerIdByContact(ORG, {
      email: 'someone-new@example.com',
      phone: '555-010-0100',
    });
    expect(result).toBe('c1');
  });

  it('returns null when nothing matches', async () => {
    selectQueue.push([
      { id: 'c1', emailEncrypted: 'enc:alice@example.com', phoneEncrypted: null },
    ]);
    const result = await findCustomerIdByContact(ORG, {
      email: 'nobody@example.com',
      phone: '999-999-9999',
    });
    expect(result).toBeNull();
  });
});

describe('deleteCustomer', () => {
  it('returns false and does not write when the customer is not in the org', async () => {
    selectQueue.push([]); // existence check → no row
    const result = await deleteCustomer(ORG, 'missing-id');
    expect(result).toBe(false);
    expect(batchMock).not.toHaveBeenCalled();
  });

  it('deletes children, detaches requests, and writes an audit row in one batch', async () => {
    selectQueue.push([{ id: 'c1' }]); // existence check → found
    const result = await deleteCustomer(ORG, 'c1', {
      userId: 'admin-1',
      ipAddress: '1.2.3.4',
    });
    expect(result).toBe(true);
    expect(batchMock).toHaveBeenCalledTimes(1);
    // 4 child deletes + 1 service_requests detach + 1 customer delete + 1 audit insert.
    const statements = batchMock.mock.calls[0][0] as unknown[];
    expect(statements).toHaveLength(7);
  });
});
