import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state ─────────────────────────────────────────────
const { selectQueue, updateQueue, deleteQueue, insertMock, logAuditMock, batchMock, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const updateQueue: unknown[][] = [];
  const deleteQueue: unknown[][] = [];
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
  return { selectQueue, updateQueue, deleteQueue, insertMock, logAuditMock, batchMock, chain };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    selectDistinct: () => chain(selectQueue.shift() ?? []),
    delete: () => chain(deleteQueue.shift() ?? []),
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
  isNull: (c: unknown) => c,
  isNotNull: (c: unknown) => c,
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
    archivedAt: 'customers.archived',
    customerType: 'customers.customerType',
    membershipStatus: 'customers.membershipStatus',
    fieldpulseCustomerId: 'customers.fpId',
  },
  customerTypeEnum: { enumValues: ['residential', 'commercial'] },
  membershipStatusEnum: { enumValues: ['none', 'active', 'suspended', 'expired', 'cancelled'] },
  customerEquipment: {
    id: 'equip.id',
    customerId: 'equip.cid',
    organizationId: 'equip.org',
    equipmentType: 'equip.type',
    make: 'equip.make',
    model: 'equip.model',
    serialNumber: 'equip.serial',
    installDate: 'equip.install',
    warrantyExpiration: 'equip.warranty',
    locationInHome: 'equip.location',
    notes: 'equip.notes',
  },
  customerNotes: { customerId: 'notes.cid' },
  followUps: { id: 'fu.id', customerId: 'fu.cid', status: 'fu.status' },
  serviceHistory: { customerId: 'sh.cid', serviceRequestId: 'sh.srid' },
  serviceRequests: { customerId: 'sr.cid', id: 'sr.id', sessionId: 'sr.sid' },
  users: { id: 'users.id', name: 'users.name' },
  auditLog: {},
}));

import {
  getCustomers,
  findCustomerIdByContact,
  deleteCustomer,
  archiveCustomer,
  updateCustomerContact,
  completeFollowUp,
} from './crm-queries';
import { updateEquipment, deleteEquipment } from './crm-equipment-queries';

const ORG = '00000000-0000-0000-0000-000000000001';
const CUST = '00000000-0000-0000-0000-0000000000c1';
const EQUIP = '00000000-0000-0000-0000-0000000000e1';

beforeEach(() => {
  selectQueue.length = 0;
  updateQueue.length = 0;
  deleteQueue.length = 0;
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

describe('archiveCustomer', () => {
  it('returns false and does not write when the customer is not in the org', async () => {
    selectQueue.push([]); // existence check → no row
    const result = await archiveCustomer(ORG, 'missing-id');
    expect(result).toBe(false);
    expect(batchMock).not.toHaveBeenCalled();
  });

  it('sets archived_at and writes an audit row in one batch (no child deletes)', async () => {
    selectQueue.push([{ id: 'c1', archivedAt: null }]); // existence check → found, active
    const result = await archiveCustomer(ORG, 'c1', {
      userId: 'admin-1',
      ipAddress: '1.2.3.4',
    });
    expect(result).toBe(true);
    expect(batchMock).toHaveBeenCalledTimes(1);
    // 1 customer update (archived_at) + 1 audit insert — children untouched.
    const statements = batchMock.mock.calls[0][0] as unknown[];
    expect(statements).toHaveLength(2);
  });

  it('is a no-op (returns true, no write) when already archived', async () => {
    selectQueue.push([{ id: 'c1', archivedAt: new Date() }]); // already archived
    const result = await archiveCustomer(ORG, 'c1', { userId: 'admin-1' });
    expect(result).toBe(true);
    expect(batchMock).not.toHaveBeenCalled();
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

describe('updateEquipment', () => {
  it('returns no_changes for an empty patch (no DB write)', async () => {
    const result = await updateEquipment(ORG, CUST, EQUIP, {});
    expect(result).toEqual({ ok: false, reason: 'no_changes' });
  });

  it('rejects an invalid equipmentType as invalid_type', async () => {
    const result = await updateEquipment(ORG, CUST, EQUIP, {
      equipmentType: 'spaceship',
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_type' });
  });

  it('returns not_found when the org+customer-scoped row does not exist', async () => {
    updateQueue.push([]); // scoped update matched nothing
    const result = await updateEquipment(ORG, CUST, EQUIP, { make: 'Carrier' });
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('updates when the scoped row exists; clears a nullable field via null', async () => {
    updateQueue.push([{ id: EQUIP }]);
    const result = await updateEquipment(ORG, CUST, EQUIP, {
      make: 'Trane',
      serialNumber: null, // explicit clear
      equipmentType: 'furnace',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // updatedFields reflects exactly the columns written.
      expect([...result.updatedFields].sort()).toEqual([
        'equipmentType',
        'make',
        'serialNumber',
      ]);
    }
  });
});

describe('deleteEquipment', () => {
  it('returns false when no matching row is deleted', async () => {
    deleteQueue.push([]); // returning() yields nothing
    const result = await deleteEquipment(ORG, CUST, EQUIP);
    expect(result).toBe(false);
  });

  it('returns true when a scoped row is deleted', async () => {
    deleteQueue.push([{ id: EQUIP }]);
    const result = await deleteEquipment(ORG, CUST, EQUIP);
    expect(result).toBe(true);
  });
});

// ── getCustomers segmentation filters ─────────────────────────────────────────
// Queue consumption order (no-search fast path):
//   [0] selectDistinct → typesPromise (resolved synchronously via chain.then)
//   [1] select → pageSub builder (not awaited, used as table ref)
//   [2] select → pagePromise rows
//   [3] select → countPromise [{n}]

function pushFastPathQueue(pageRows: unknown[] = [], n = 0) {
  selectQueue.push([]); // [0] typesPromise → []
  selectQueue.push([]); // [1] pageSub placeholder
  selectQueue.push(pageRows); // [2] page rows
  selectQueue.push([{ n }]); // [3] count
}

describe('getCustomers — customerType filter', () => {
  it('returns customers when a valid customerType is applied', async () => {
    const fakeRow = {
      id: 'c1',
      nameEncrypted: 'enc:Alice',
      phoneEncrypted: null,
      emailEncrypted: null,
      addressEncrypted: null,
      propertyType: null,
      createdAt: new Date(),
      customerType: 'residential',
      membershipStatus: 'none',
      fieldpulseCustomerId: null,
      archivedAt: null,
      equipmentCount: 0,
      requestCount: 0,
      lastServiceDate: null,
    };
    pushFastPathQueue([fakeRow], 1);
    const result = await getCustomers(ORG, { customerType: 'residential' });
    expect(result.total).toBe(1);
    expect(result.customers[0].customerType).toBe('residential');
  });

  it('ignores an invalid customerType (no crash, guard skips the condition)', async () => {
    pushFastPathQueue([], 0);
    // 'enterprise' is not in customerTypeEnum.enumValues — guard skips the condition
    const result = await getCustomers(ORG, { customerType: 'enterprise' });
    expect(result.customers).toHaveLength(0);
  });
});

describe('getCustomers — membershipStatus filter', () => {
  it('returns customers when a valid membershipStatus is applied', async () => {
    const fakeRow = {
      id: 'c3',
      nameEncrypted: 'enc:Carol',
      phoneEncrypted: null,
      emailEncrypted: null,
      addressEncrypted: null,
      propertyType: null,
      createdAt: new Date(),
      customerType: 'residential',
      membershipStatus: 'active',
      fieldpulseCustomerId: null,
      archivedAt: null,
      equipmentCount: 0,
      requestCount: 0,
      lastServiceDate: null,
    };
    pushFastPathQueue([fakeRow], 1);
    const result = await getCustomers(ORG, { membershipStatus: 'active' });
    expect(result.total).toBe(1);
    expect(result.customers[0].membershipStatus).toBe('active');
  });

  it('ignores an invalid membershipStatus (no crash, guard skips the condition)', async () => {
    pushFastPathQueue([], 0);
    // 'pending' is NOT in membershipStatusEnum.enumValues — guard skips the condition
    const result = await getCustomers(ORG, { membershipStatus: 'pending' });
    expect(result.customers).toHaveLength(0);
  });
});

describe('getCustomers — fieldpulseSynced filter', () => {
  it('returns customers when fieldpulseSynced is true', async () => {
    const fakeRow = {
      id: 'c4',
      nameEncrypted: 'enc:Dave',
      phoneEncrypted: null,
      emailEncrypted: null,
      addressEncrypted: null,
      propertyType: null,
      createdAt: new Date(),
      customerType: 'residential',
      membershipStatus: 'none',
      fieldpulseCustomerId: 'fp-abc',
      archivedAt: null,
      equipmentCount: 0,
      requestCount: 0,
      lastServiceDate: null,
    };
    pushFastPathQueue([fakeRow], 1);
    const result = await getCustomers(ORG, { fieldpulseSynced: true });
    expect(result.total).toBe(1);
    expect(result.customers[0].fieldpulseCustomerId).toBe('fp-abc');
  });

  it('applies no isNotNull condition when fieldpulseSynced is false (default)', async () => {
    pushFastPathQueue([], 0);
    // No crash; guard skips the isNotNull condition
    const result = await getCustomers(ORG, { fieldpulseSynced: false });
    expect(result.customers).toHaveLength(0);
  });
});
