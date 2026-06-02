import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state ─────────────────────────────────────────────
const { selectQueue, updateQueue, insertMock, logAuditMock, batchMock, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const updateQueue: unknown[][] = [];
  const insertMock = vi.fn();
  const logAuditMock = vi.fn(async (..._args: unknown[]) => {});
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
  return { selectQueue, updateQueue, insertMock, logAuditMock, batchMock, chain };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    delete: () => chain([]),
    insert: () => {
      insertMock();
      return chain([]);
    },
    update: () => chain(updateQueue.shift() ?? []),
    batch: (...args: unknown[]) => batchMock(...args),
  },
}));

vi.mock('@/lib/admin/audit', () => ({
  logAudit: (...args: unknown[]) => logAuditMock(...args),
}));

vi.mock('@/lib/crypto', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
  // Deterministic stand-in for the HMAC blind index: same input -> same token.
  blindIndex: (v: string) => `bi:${v}`,
}));

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, _orgId: string, ...conditions: unknown[]) =>
    conditions[0] ?? true,
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => a,
  ne: (...a: unknown[]) => a,
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
    emailHash: 'customers.emailHash',
    phoneHash: 'customers.phoneHash',
    propertyType: 'customers.pt',
    propertySqft: 'customers.sqft',
    notes: 'customers.notes',
    createdAt: 'customers.created',
    updatedAt: 'customers.updated',
  },
  customerEquipment: { customerId: 'equip.cid' },
  customerNotes: { customerId: 'notes.cid' },
  followUps: { id: 'fu.id', customerId: 'fu.cid', status: 'fu.status' },
  serviceHistory: { customerId: 'sh.cid', serviceRequestId: 'sh.srid' },
  serviceRequests: { customerId: 'sr.cid', id: 'sr.id', sessionId: 'sr.sid' },
  users: { id: 'users.id', name: 'users.name' },
  auditLog: {},
}));

import {
  findCustomerIdByContact,
  deleteCustomer,
  updateCustomerContact,
  completeFollowUp,
} from './crm-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  selectQueue.length = 0;
  updateQueue.length = 0;
  insertMock.mockClear();
  logAuditMock.mockClear();
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

  it('matches by the email blind index (fast path, indexed lookup)', async () => {
    // Select #1 = email-hash lookup; returns the matching row directly.
    selectQueue.push([{ id: 'c2' }]);
    const result = await findCustomerIdByContact(ORG, {
      email: 'BOB@Example.com',
      phone: null,
    });
    expect(result).toBe('c2');
  });

  it('falls back to the phone blind index when email does not match', async () => {
    selectQueue.push([]); // #1 email-hash: no hit
    selectQueue.push([{ id: 'c1' }]); // #2 phone-hash: hit
    const result = await findCustomerIdByContact(ORG, {
      email: 'someone-new@example.com',
      phone: '555-010-0100',
    });
    expect(result).toBe('c1');
  });

  it('falls back to the legacy decrypt scan for rows with no blind index', async () => {
    // Email only (no phone), so there are just two selects: the email-hash
    // fast path, then the legacy scan.
    selectQueue.push([]); // #1 email-hash: no hit
    // #2 legacy scan (hashes NULL): decrypt-and-compare matches by email.
    selectQueue.push([
      {
        id: 'legacy-1',
        emailEncrypted: 'enc:bob@example.com',
        phoneEncrypted: null,
        emailHash: null,
        phoneHash: null,
      },
    ]);
    const result = await findCustomerIdByContact(ORG, {
      email: 'BOB@Example.com',
      phone: null,
    });
    expect(result).toBe('legacy-1');
  });

  it('returns null when nothing matches on any path', async () => {
    selectQueue.push([]); // #1 email-hash
    selectQueue.push([]); // #2 phone-hash
    selectQueue.push([]); // #3 legacy scan
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

describe('updateCustomerContact', () => {
  it('returns not_found and does not write when the customer is absent', async () => {
    selectQueue.push([]); // existence check → no row
    const result = await updateCustomerContact(ORG, 'missing', { name: 'X' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('updates a subset of fields and writes one audit entry', async () => {
    selectQueue.push([{ id: 'c1', emailHash: null, phoneHash: null }]);
    const result = await updateCustomerContact(ORG, 'c1', {
      name: 'New Name',
      address: '1 New St',
    });
    expect(result).toEqual({ ok: true });
  });

  it('is a no-op (no write) when the patch contains nothing to change', async () => {
    selectQueue.push([{ id: 'c1', emailHash: null, phoneHash: null }]);
    // Only a blank name → name is skipped (NOT NULL) and nothing else is set.
    const result = await updateCustomerContact(ORG, 'c1', { name: '   ' });
    expect(result).toEqual({ ok: true });
    expect(logAuditMock).not.toHaveBeenCalled(); // no phantom audit row
  });

  it('rejects with contact_conflict when the new email belongs to another customer', async () => {
    // #1 existence (current emailHash differs from the new one)
    selectQueue.push([{ id: 'c1', emailHash: 'bi:old@x.com', phoneHash: null }]);
    // #2 email-hash clash check → a DIFFERENT customer already owns it
    selectQueue.push([{ id: 'c2' }]);
    const result = await updateCustomerContact(ORG, 'c1', {
      email: 'taken@example.com',
    });
    expect(result).toEqual({ ok: false, reason: 'contact_conflict' });
  });

  it('allows re-saving the same email (hash unchanged → no clash query)', async () => {
    // normalizeEmail+blindIndex('same@x.com') === 'bi:same@x.com'
    selectQueue.push([
      { id: 'c1', emailHash: 'bi:same@x.com', phoneHash: null },
    ]);
    const result = await updateCustomerContact(ORG, 'c1', {
      email: 'Same@X.com',
    });
    expect(result).toEqual({ ok: true });
    // Only the existence select was consumed — no clash check ran.
    expect(selectQueue.length).toBe(0);
  });
});

describe('completeFollowUp', () => {
  it('returns false and writes no audit when no pending follow-up matches', async () => {
    updateQueue.push([]); // status-guarded update matched nothing
    const result = await completeFollowUp(ORG, 'fu-missing');
    expect(result).toBe(false);
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it('marks complete and writes an audit entry when a pending row matches', async () => {
    updateQueue.push([{ id: 'fu-1' }]);
    const result = await completeFollowUp(ORG, 'fu-1', { userId: 'admin-1' });
    expect(result).toBe(true);
    expect(logAuditMock).toHaveBeenCalledTimes(1);
  });
});
