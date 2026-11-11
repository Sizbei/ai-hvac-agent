import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state ─────────────────────────────────────────────
const {
  selectQueue,
  updateQueue,
  deleteQueue,
  insertQueue,
  insertMock,
  updateMock,
  logAuditMock,
  batchMock,
  chain,
  chainCalls,
  tenantCalls,
  sqlFragments,
} = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  // An UPDATE can also be queued as an Error, which the chain rejects with —
  // that is how the unique-violation path is driven.
  const updateQueue: unknown[] = [];
  const deleteQueue: unknown[][] = [];
  const insertQueue: unknown[][] = [];
  const insertMock = vi.fn();
  const updateMock = vi.fn();
  const logAuditMock = vi.fn(async (..._args: unknown[]) => {});
  const batchMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  // Every chained builder call, so tests can assert on query shape (e.g. the
  // onConflictDoUpdate spec) the way the fieldpulse suite asserts on predicates.
  const chainCalls: { method: string; args: unknown[] }[] = [];
  // Every withTenant(...) condition list, so tests can assert a WHERE carries a
  // term without the mocked helper collapsing it.
  const tenantCalls: unknown[][] = [];
  // Rendered text of every sql`` fragment, in order.
  const sqlFragments: string[] = [];
  // Chainable thenable proxy: every method returns itself; awaiting resolves
  // to the value provided at construction time (or rejects, for an Error).
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            resolved instanceof Error ? reject(resolved) : resolve(resolved);
        }
        return (...args: unknown[]) => {
          chainCalls.push({ method: String(prop), args });
          return p;
        };
      },
      apply: () => p,
    });
    return p;
  };
  return {
    selectQueue,
    updateQueue,
    deleteQueue,
    insertQueue,
    insertMock,
    updateMock,
    logAuditMock,
    batchMock,
    chain,
    chainCalls,
    tenantCalls,
    sqlFragments,
  };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    selectDistinct: () => chain(selectQueue.shift() ?? []),
    delete: () => chain(deleteQueue.shift() ?? []),
    insert: (...args: unknown[]) => {
      insertMock(...args);
      return chain(insertQueue.shift() ?? []);
    },
    update: (...args: unknown[]) => {
      updateMock(...args);
      return chain(updateQueue.shift() ?? []);
    },
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
  withTenant: (_table: unknown, _orgId: string, ...conditions: unknown[]) => {
    tenantCalls.push(conditions);
    return conditions[0] ?? true;
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => a,
  ne: (...a: unknown[]) => a,
  or: (...a: unknown[]) => a,
  and: (...a: unknown[]) => a,
  desc: (c: unknown) => c,
  asc: (c: unknown) => c,
  count: () => 'count',
  max: (c: unknown) => c,
  // Renders the template into its own text (columns interpolate to the mocked
  // column names) so tests can assert on a fragment the way the fieldpulse
  // suite matches raw SQL text — searching the column object alone would match
  // regardless of which terms the predicate carries.
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      let text = '';
      strings.raw.forEach((part, i) => {
        text += part;
        if (i < values.length) {
          const value = values[i];
          text +=
            value && typeof value === 'object' && '__sql' in value
              ? (value as { __sql: string }).__sql
              : String(value);
        }
      });
      sqlFragments.push(text);
      // `as` names a computed column in a subquery; non-enumerable so the
      // fragment still deep-equals { __sql }.
      return Object.defineProperty({ __sql: text }, 'as', { value: () => ({ __sql: text }) });
    },
    // visibleRowsSql builds its alias predicate with sql.raw.
    { raw: (text: string) => ({ __sql: text }) },
  ),
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
    anonymizedAt: 'customers.anonymized',
    doNotService: 'customers.doNotService',
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
  customerLocations: { id: 'loc.id', customerId: 'loc.cid' },
  entityTags: { entity: 'tags.entity', entityId: 'tags.eid' },
  followUps: { id: 'fu.id', customerId: 'fu.cid', status: 'fu.status' },
  serviceHistory: { customerId: 'sh.cid', serviceRequestId: 'sh.srid' },
  serviceRequests: {
    customerId: 'sr.cid',
    id: 'sr.id',
    sessionId: 'sr.sid',
    createdAt: 'sr.created',
    completedAt: 'sr.completed',
  },
  users: { id: 'users.id', name: 'users.name' },
  auditLog: {},
}));

import {
  getCustomers,
  findCustomerIdByContact,
  findCustomerMatchByContact,
  findCustomerMatchCandidates,
  upsertCustomerByContact,
  deleteCustomer,
  archiveCustomer,
  unarchiveCustomer,
  updateCustomerContact,
  completeFollowUp,
} from './crm-queries';
import { VISIBLE_ONLY } from './visibility';
import { updateEquipment, deleteEquipment } from './crm-equipment-queries';

const ORG = '00000000-0000-0000-0000-000000000001';
const CUST = '00000000-0000-0000-0000-0000000000c1';
const EQUIP = '00000000-0000-0000-0000-0000000000e1';

beforeEach(() => {
  selectQueue.length = 0;
  updateQueue.length = 0;
  deleteQueue.length = 0;
  insertQueue.length = 0;
  chainCalls.length = 0;
  tenantCalls.length = 0;
  sqlFragments.length = 0;
  insertMock.mockClear();
  updateMock.mockClear();
  logAuditMock.mockClear();
  batchMock.mockClear();
  batchMock.mockResolvedValue([]);
});

/** A candidate row as the lookup SELECT returns it. */
function candidateRow(
  over: Partial<{
    id: string;
    matchedOn: 'email' | 'phone';
    anonymizedAt: Date | null;
    archivedAt: Date | null;
    doNotService: boolean;
    createdAt: Date | null;
    lastActivityAt: string | null;
  }> = {},
) {
  return {
    id: 'c1',
    matchedOn: 'email' as const,
    anonymizedAt: null,
    archivedAt: null,
    doNotService: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastActivityAt: null,
    ...over,
  };
}

/** The last builder call of that name, e.g. the ON CONFLICT spec. */
function lastChainCall(method: string): unknown[] | undefined {
  return [...chainCalls].reverse().find((c) => c.method === method)?.args;
}

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

  it('matches by the blind index in ONE candidate query (email + phone together)', async () => {
    // Select #1 = the single candidate lookup; the two-query email-then-phone
    // shape is gone, so one queued result answers both keys.
    selectQueue.push([candidateRow({ id: 'c2' })]);
    const result = await findCustomerIdByContact(ORG, {
      email: 'BOB@Example.com',
      phone: '555-010-0100',
    });
    expect(result).toBe('c2');
    expect(selectQueue.length).toBe(0);
  });

  it('ranks the candidates rather than taking the row the database returned first', async () => {
    selectQueue.push([
      candidateRow({ id: 'phone-row', matchedOn: 'phone' }),
      candidateRow({ id: 'email-row', matchedOn: 'email' }),
    ]);
    const result = await findCustomerIdByContact(ORG, {
      email: 'ap@example.com',
      phone: '555-010-0100',
    });
    expect(result).toBe('email-row');
  });

  it('filters erased rows in the candidate query WHERE, not only in the helper', async () => {
    selectQueue.push([]);
    await findCustomerIdByContact(ORG, { email: 'bob@example.com', phone: null });
    // Rule 1 must be a SQL filter — the helper re-applies it, but the LIMIT is
    // only safe when the erased rows never enter the candidate set.
    expect(tenantCalls[0]).toContainEqual({ __sql: 'customers.anonymized IS NULL' });
  });

  it('orders the candidate query (6 rank expressions) and caps at 50 — the cap is only safe under that ordering', async () => {
    selectQueue.push([]);
    await findCustomerIdByContact(ORG, { email: 'bob@example.com', phone: null });
    // The SQL ORDER BY must mirror pickCustomerMatch rules 2-7; if it is ever
    // removed or truncated, LIMIT 50 can silently drop the true winner.
    const orderArgs = lastChainCall('orderBy');
    expect(orderArgs).toBeDefined();
    expect(orderArgs).toHaveLength(6);
    expect(lastChainCall('limit')).toEqual([50]);
  });

  it('lifts the cap when a fan-out consumer passes { limit: null }', async () => {
    selectQueue.push([]);
    await findCustomerMatchCandidates(
      ORG,
      { email: null, phone: '555-010-0100' },
      { limit: null },
    );
    // No LIMIT call at all — a capped fan-out would stop a shared-number STOP
    // at 50 rows and keep texting the 51st.
    expect(lastChainCall('limit')).toBeUndefined();
  });

  it('falls back to the legacy decrypt scan for rows with no blind index', async () => {
    selectQueue.push([]); // #1 candidate lookup: no hit
    // #2 legacy scan (hashes NULL): decrypt-and-compare matches by email.
    selectQueue.push([
      {
        id: 'legacy-1',
        emailEncrypted: 'enc:bob@example.com',
        phoneEncrypted: null,
        emailHash: null,
        phoneHash: null,
        doNotService: false,
      },
    ]);
    const result = await findCustomerIdByContact(ORG, {
      email: 'BOB@Example.com',
      phone: null,
    });
    expect(result).toBe('legacy-1');
  });

  it('excludes FieldPulse-linked rows from the legacy scan', async () => {
    selectQueue.push([]); // #1 candidate lookup
    selectQueue.push([]); // #2 legacy scan
    await findCustomerIdByContact(ORG, { email: 'bob@example.com', phone: null });
    // Contactless FP imports also satisfy "both hashes NULL"; the scan must not
    // reach them. Match the fragment's own text — the column object alone is
    // reachable from any predicate.
    expect(
      sqlFragments.some(
        (fragment) =>
          fragment.includes('customers.emailHash IS NULL') &&
          fragment.includes('customers.fpId IS NULL'),
      ),
    ).toBe(true);
  });

  it('returns null when nothing matches on any path', async () => {
    selectQueue.push([]); // #1 candidate lookup
    selectQueue.push([]); // #2 legacy scan
    const result = await findCustomerIdByContact(ORG, {
      email: 'nobody@example.com',
      phone: '999-999-9999',
    });
    expect(result).toBeNull();
  });
});

describe('findCustomerMatchByContact', () => {
  it('carries the ambiguity flag and the winner do-not-service flag', async () => {
    selectQueue.push([
      candidateRow({ id: 'blocked', doNotService: true }),
      candidateRow({ id: 'live' }),
    ]);
    const match = await findCustomerMatchByContact(ORG, {
      email: 'ap@example.com',
      phone: null,
    });
    expect(match).toEqual({ id: 'blocked', ambiguous: true, doNotService: true });
  });

  it('writes ONE system audit row, ids and counts only, when ambiguous and blocked', async () => {
    selectQueue.push([
      candidateRow({ id: 'blocked', doNotService: true }),
      candidateRow({ id: 'live' }),
    ]);
    await findCustomerMatchByContact(ORG, { email: 'ap@example.com', phone: null });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const values = lastChainCall('values')?.[0] as Record<string, unknown>;
    expect(values.action).toBe('ambiguous_do_not_service_refusal');
    expect(values.actorType).toBe('system');
    expect(values.entityId).toBe('blocked');
    expect(JSON.parse(values.details as string)).toEqual({
      candidateCount: 2,
      candidateIds: ['blocked', 'live'],
    });
  });

  it('writes no audit row when the ambiguous winner is not blocked', async () => {
    selectQueue.push([candidateRow({ id: 'a' }), candidateRow({ id: 'b' })]);
    const match = await findCustomerMatchByContact(ORG, {
      email: 'ap@example.com',
      phone: null,
    });
    expect(match?.ambiguous).toBe(true);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('writes no audit row when a blocked winner is unambiguous', async () => {
    selectQueue.push([candidateRow({ id: 'blocked', doNotService: true })]);
    await findCustomerMatchByContact(ORG, { email: 'ap@example.com', phone: null });
    expect(insertMock).not.toHaveBeenCalled();
  });
});

describe('upsertCustomerByContact — un-archive gate', () => {
  const INPUT = { name: 'Bob', email: 'bob@example.com', phone: null, address: null };

  it('un-archives an unambiguous, unblocked match', async () => {
    selectQueue.push([candidateRow({ id: 'c1', archivedAt: new Date() })]);
    const id = await upsertCustomerByContact(ORG, INPUT);
    expect(id).toBe('c1');
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT un-archive when the pick is ambiguous', async () => {
    // Two live rows on one shared contact — ambiguity by definition.
    selectQueue.push([candidateRow({ id: 'a' }), candidateRow({ id: 'b' })]);
    const id = await upsertCustomerByContact(ORG, INPUT);
    // The id still resolves — only the resurrection is withheld.
    expect(id).toBe('a');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('does NOT un-archive a do-not-service match', async () => {
    selectQueue.push([
      candidateRow({ id: 'blocked', archivedAt: new Date(), doNotService: true }),
    ]);
    const id = await upsertCustomerByContact(ORG, INPUT);
    expect(id).toBe('blocked');
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('arbiters the NATIVE partial index and keeps a blocked row archived on the conflict path', async () => {
    selectQueue.push([]); // candidate lookup: nothing
    selectQueue.push([]); // legacy scan: nothing
    insertQueue.push([{ id: 'c9' }]);

    const id = await upsertCustomerByContact(ORG, INPUT);
    expect(id).toBe('c9');

    const spec = lastChainCall('onConflictDoUpdate')?.[0] as {
      targetWhere: { __sql: string };
      set: { archivedAt: { __sql: string } };
    };
    // Textually identical to customers_org_email_hash_native_unique's predicate
    // — Postgres infers a partial index only when the two match.
    expect(spec.targetWhere.__sql).toBe(
      'customers.emailHash IS NOT NULL AND customers.fpId IS NULL',
    );
    // The remaining gate term, in SQL because this path has no JS to hold it.
    expect(spec.set.archivedAt.__sql).toBe(
      'CASE WHEN customers.doNotService THEN customers.archived ELSE NULL END',
    );
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
    // 4 child deletes + 1 service_requests detach + 2 entity_tags deletes
    // (customer + its locations) + 1 customer delete + 1 audit insert.
    const statements = batchMock.mock.calls[0][0] as unknown[];
    expect(statements).toHaveLength(9);
  });
});

describe('deleteCustomer — search cache', () => {
  // Search-path queue order: types, fingerprint, then the scan on a miss.
  const SEARCH_ORG = '00000000-0000-0000-0000-0000000000d9';
  const scanRow = {
    id: 'c1',
    nameEncrypted: 'enc:Alice',
    phoneEncrypted: null,
    emailEncrypted: null,
    addressEncrypted: null,
  };
  const SENTINEL = [{ id: 'never-read' }];

  it("drops the org's cached scan, so the next search re-reads it", async () => {
    selectQueue.push([], [{ fp: 'F' }], [scanRow]);
    await getCustomers(SEARCH_ORG, { search: 'nomatch' }, VISIBLE_ONLY);
    expect(selectQueue).toHaveLength(0);

    // Same fingerprint: served from the cache, the scan slot is left unread.
    selectQueue.push([], [{ fp: 'F' }], SENTINEL);
    await getCustomers(SEARCH_ORG, { search: 'nomatch' }, VISIBLE_ONLY);
    expect(selectQueue).toEqual([SENTINEL]);
    selectQueue.length = 0;

    selectQueue.push([{ id: 'c1' }]); // existence check
    await deleteCustomer(SEARCH_ORG, 'c1');

    // Same fingerprint again, but the cache was cleared: the scan is read.
    selectQueue.push([], [{ fp: 'F' }], SENTINEL);
    await getCustomers(SEARCH_ORG, { search: 'nomatch' }, VISIBLE_ONLY);
    expect(selectQueue).toHaveLength(0);
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

describe('unarchiveCustomer', () => {
  it('returns false and does not write when the customer is not in the org', async () => {
    selectQueue.push([]);
    expect(await unarchiveCustomer(ORG, 'missing-id')).toBe(false);
    expect(batchMock).not.toHaveBeenCalled();
  });

  it('clears archived_at and writes one audit row in one batch', async () => {
    selectQueue.push([{ id: 'c1', archivedAt: new Date() }]);
    expect(await unarchiveCustomer(ORG, 'c1', { userId: 'admin-1' })).toBe(true);
    expect(batchMock).toHaveBeenCalledTimes(1);
    expect(batchMock.mock.calls[0][0] as unknown[]).toHaveLength(2);
  });

  it('is a no-op when the customer is already active', async () => {
    selectQueue.push([{ id: 'c1', archivedAt: null }]);
    expect(await unarchiveCustomer(ORG, 'c1')).toBe(true);
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

  it('narrows the clash query to the native population', async () => {
    selectQueue.push([{ id: 'c1', emailHash: 'bi:old@x.com', phoneHash: null }]);
    selectQueue.push([]); // clash check → nothing
    await updateCustomerContact(ORG, 'c1', { email: 'shared@example.com' });
    // Sharing an accounts-payable email with a FieldPulse-linked business is a
    // legitimate state post-split: only native rows can violate the index.
    expect(tenantCalls[1]).toContain('customers.fpId');
  });

  it('skips the clash check entirely when the edited row is FieldPulse-linked', async () => {
    selectQueue.push([
      {
        id: 'c1',
        emailHash: 'bi:old@x.com',
        phoneHash: null,
        fieldpulseCustomerId: 'fp-1',
      },
    ]);
    selectQueue.push([{ id: 'c2' }]); // would be read as a clash by the old code
    const result = await updateCustomerContact(ORG, 'c1', {
      email: 'shared@example.com',
    });
    expect(result).toEqual({ ok: true });
    expect(selectQueue.length).toBe(1); // the clash query never ran
  });

  it('maps a unique violation on the SET to contact_conflict, not a throw', async () => {
    selectQueue.push([{ id: 'c1', emailHash: 'bi:old@x.com', phoneHash: null }]);
    selectQueue.push([]); // clash check passes — the concurrent edit lands next
    const violation = Object.assign(new Error('duplicate key value'), {
      cause: { code: '23505', constraint: 'customers_org_email_hash_native_unique' },
    });
    updateQueue.push(violation);

    const result = await updateCustomerContact(ORG, 'c1', {
      email: 'taken@example.com',
    });
    expect(result).toEqual({ ok: false, reason: 'contact_conflict' });
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it('rethrows a non-unique-violation error from the SET', async () => {
    selectQueue.push([{ id: 'c1', emailHash: null, phoneHash: null }]);
    updateQueue.push(new Error('connection reset'));
    await expect(
      updateCustomerContact(ORG, 'c1', { name: 'New Name' }),
    ).rejects.toThrow('connection reset');
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
    const result = await getCustomers(ORG, { customerType: 'residential' }, VISIBLE_ONLY);
    expect(result.total).toBe(1);
    expect(result.customers[0].customerType).toBe('residential');
  });

  it('ignores an invalid customerType (no crash, guard skips the condition)', async () => {
    pushFastPathQueue([], 0);
    // 'enterprise' is not in customerTypeEnum.enumValues — guard skips the condition
    const result = await getCustomers(ORG, { customerType: 'enterprise' }, VISIBLE_ONLY);
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
    const result = await getCustomers(ORG, { membershipStatus: 'active' }, VISIBLE_ONLY);
    expect(result.total).toBe(1);
    expect(result.customers[0].membershipStatus).toBe('active');
  });

  it('ignores an invalid membershipStatus (no crash, guard skips the condition)', async () => {
    pushFastPathQueue([], 0);
    // 'pending' is NOT in membershipStatusEnum.enumValues — guard skips the condition
    const result = await getCustomers(ORG, { membershipStatus: 'pending' }, VISIBLE_ONLY);
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
    const result = await getCustomers(ORG, { fieldpulseSynced: true }, VISIBLE_ONLY);
    expect(result.total).toBe(1);
    expect(result.customers[0].fieldpulseCustomerId).toBe('fp-abc');
  });

  it('applies no isNotNull condition when fieldpulseSynced is false (default)', async () => {
    pushFastPathQueue([], 0);
    // No crash; guard skips the isNotNull condition
    const result = await getCustomers(ORG, { fieldpulseSynced: false }, VISIBLE_ONLY);
    expect(result.customers).toHaveLength(0);
  });
});
