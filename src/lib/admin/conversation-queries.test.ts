import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state ─────────────────────────────────────────────
const { selectQueue, batchMock, chain, deleteCalls, updateCalls, updateQueue, insertCalls } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const updateQueue: unknown[][] = [];
  const insertCalls: Array<{ table: unknown; values: unknown }> = [];
  const batchMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  const deleteCalls: unknown[] = [];
  const updateCalls: Array<{ table: unknown; values: unknown }> = [];
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
  return { selectQueue, batchMock, chain, deleteCalls, updateCalls, updateQueue, insertCalls };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    delete: (table: unknown) => {
      deleteCalls.push(table);
      return chain([]);
    },
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        insertCalls.push({ table, values });
        return chain([]);
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => {
        updateCalls.push({ table, values });
        return chain(updateQueue.shift() ?? []);
      },
    }),
    batch: (...args: unknown[]) => batchMock(...args),
  },
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
  customerSessions: {
    id: 'sessions.id',
    organizationId: 'sessions.org',
    status: 'sessions.status',
    channel: 'sessions.channel',
    runningSummary: 'sessions.running_summary',
    createdAt: 'sessions.created',
  },
  sessionChannelEnum: { enumValues: ['web', 'phone', 'sms'] },
  messages: { sessionId: 'messages.sid', organizationId: 'messages.org' },
  serviceRequests: {
    id: 'sr.id',
    sessionId: 'sr.sid',
    organizationId: 'sr.org',
    referenceNumber: 'sr.ref',
  },
  customers: { id: 'customers.id', organizationId: 'customers.org', nameEncrypted: 'customers.name' },
  serviceHistory: { serviceRequestId: 'sh.srid', organizationId: 'sh.org' },
  entityTags: { entity: 'tags.entity', entityId: 'tags.eid', organizationId: 'tags.org' },
  auditLog: { sessionId: 'audit.sid', organizationId: 'audit.org' },
}));

// "enc:<plain>" decrypts to <plain>; anything else is undecryptable.
vi.mock('@/lib/crypto', () => ({
  decrypt: (v: string) => {
    if (!v.startsWith('enc:')) throw new Error('bad ciphertext');
    return v.slice(4);
  },
}));

import {
  deleteConversation,
  getConversations,
  getConversationById,
  setConversationHandled,
} from './conversation-queries';
import { auditLog } from '@/lib/db/schema';

const ORG = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  selectQueue.length = 0;
  batchMock.mockClear();
  batchMock.mockResolvedValue([]);
  deleteCalls.length = 0;
  updateCalls.length = 0;
  updateQueue.length = 0;
  insertCalls.length = 0;
});

describe('getConversations', () => {
  const sessionRow = (handledAt: Date | null) => ({
    id: 's1',
    status: 'escalated',
    channel: 'web',
    turnCount: 2,
    tokensUsed: 10,
    metadata: null,
    handledAt,
    createdAt: new Date('2026-06-08T00:00:00Z'),
    updatedAt: new Date('2026-06-08T00:05:00Z'),
  });
  const run = async (handledAt: Date | null, customerWroteAt: string) => {
    batchMock.mockResolvedValueOnce([[{ value: 1 }], [sessionRow(handledAt)], [{ value: 1 }]]);
    // The three batched builders call db.select() too (results come from batch).
    selectQueue.push([], [], []);
    selectQueue.push([]); // aggregates
    selectQueue.push([
      { sessionId: 's1', content: 'first', createdAt: new Date('2026-06-08T00:00:30Z') },
      { sessionId: 's1', content: 'again', createdAt: new Date(customerWroteAt) },
    ]); // customer messages, ascending
    selectQueue.push([{ sessionId: 's1', referenceNumber: 'HVAC-1', requestNameEncrypted: 'enc:Ada', customerNameEncrypted: null }]);
    return (await getConversations(ORG, {})).conversations[0];
  };

  it('flags needs action from handledAt and the LAST customer message', async () => {
    expect((await run(null, '2026-06-08T00:01:00Z')).needsAction).toBe(true);
    expect((await run(new Date('2026-06-08T00:02:00Z'), '2026-06-08T00:01:00Z')).needsAction).toBe(false);
    // The customer wrote again after it was marked handled → back in the queue.
    expect((await run(new Date('2026-06-08T00:02:00Z'), '2026-06-08T00:03:00Z')).needsAction).toBe(true);
  });

  it("carries the first message preview and the request's customer name", async () => {
    const row = await run(null, '2026-06-08T00:01:00Z');
    expect(row.preview).toBe('first');
    expect(row.requestCustomerName).toBe('Ada');
    expect(row.referenceNumber).toBe('HVAC-1');
  });
});

describe('getConversationById', () => {
  it('surfaces the channel and running summary in the detail', async () => {
    selectQueue.push([
      {
        id: 's1',
        status: 'chatting',
        channel: 'phone',
        turnCount: 3,
        tokensUsed: 100,
        tokenBudget: 10000,
        metadata: null,
        runningSummary: 'Caller reported no heat at 5 Oak St.',
        createdAt: new Date('2026-06-08T00:00:00Z'),
        updatedAt: new Date('2026-06-08T00:05:00Z'),
      },
    ]); // session row
    selectQueue.push([]); // messages
    batchMock.mockResolvedValueOnce([[], []]); // service request + reply audit rows

    const detail = await getConversationById(ORG, 's1');
    expect(detail).not.toBeNull();
    expect(detail?.channel).toBe('phone');
    expect(detail?.runningSummary).toBe('Caller reported no heat at 5 Oak St.');
    expect(detail?.serviceRequestId).toBeNull();
    expect(detail?.needsAction).toBe(false);
  });

  it('links the request and flags an unhandled escalation', async () => {
    selectQueue.push([
      {
        id: 's1',
        status: 'escalated',
        channel: 'phone',
        turnCount: 3,
        tokensUsed: 100,
        tokenBudget: 10000,
        metadata: null,
        runningSummary: null,
        handledAt: null,
        createdAt: new Date('2026-06-08T00:00:00Z'),
        updatedAt: new Date('2026-06-08T00:05:00Z'),
      },
    ]);
    selectQueue.push([]); // messages
    batchMock.mockResolvedValueOnce([
      [{ id: 'req-1', referenceNumber: 'HVAC-1' }],
      [{ createdAt: new Date('2026-06-08T00:04:00Z') }],
    ]);

    const detail = await getConversationById(ORG, 's1');
    expect(detail?.serviceRequestId).toBe('req-1');
    expect(detail?.referenceNumber).toBe('HVAC-1');
    expect(detail?.needsAction).toBe(true);
    expect(detail?.staffReplyTimes).toEqual(['2026-06-08T00:04:00.000Z']);
  });

  it("names the linked request's customer, falling back to the customer row, never an erased one", async () => {
    const session = {
      id: 's1',
      status: 'submitted',
      channel: 'web',
      turnCount: 3,
      tokensUsed: 100,
      tokenBudget: 10000,
      metadata: null,
      runningSummary: null,
      handledAt: null,
      createdAt: new Date('2026-06-08T00:00:00Z'),
      updatedAt: new Date('2026-06-08T00:05:00Z'),
    };
    const run = async (requestNameEncrypted: string | null, customerNameEncrypted: string | null) => {
      selectQueue.push([session]);
      selectQueue.push([]);
      batchMock.mockResolvedValueOnce([
        [{ id: 'req-1', referenceNumber: 'HVAC-1', requestNameEncrypted, customerNameEncrypted }],
        [],
      ]);
      return (await getConversationById(ORG, 's1'))?.requestCustomerName;
    };
    expect(await run('enc:Watauga Storage', 'enc:Other')).toBe('Watauga Storage');
    expect(await run(null, 'enc:Watauga Storage')).toBe('Watauga Storage');
    expect(await run('garbage', 'enc:Watauga Storage')).toBe('Watauga Storage');
    expect(await run('enc:[deleted]', null)).toBeNull();
    expect(await run(null, null)).toBeNull();
  });

  it('returns null when the session is not in the org', async () => {
    selectQueue.push([]); // session row missing
    const detail = await getConversationById(ORG, 'nope');
    expect(detail).toBeNull();
  });
});

describe('deleteConversation', () => {
  it('returns false and does not write when the session is not in the org', async () => {
    selectQueue.push([]); // existence check → no row
    const result = await deleteConversation(ORG, 'missing-session');
    expect(result).toBe(false);
    expect(batchMock).not.toHaveBeenCalled();
  });

  it('cascades dependents and writes a deletion audit row in one batch', async () => {
    selectQueue.push([{ id: 's1' }]); // existence check → found
    const result = await deleteConversation(ORG, 's1', {
      userId: 'admin-1',
      ipAddress: '1.2.3.4',
    });
    expect(result).toBe(true);
    expect(batchMock).toHaveBeenCalledTimes(1);
    // service_history + job entity_tags + service_requests + audit_log (updated, not deleted) +
    // messages + session deletes, then the conversation_deleted audit insert.
    const statements = batchMock.mock.calls[0][0] as unknown[];
    expect(statements).toHaveLength(7);
  });

  it('preserves audit_log rows by nulling sessionId instead of deleting them', async () => {
    selectQueue.push([{ id: 's1' }]); // existence check → found
    await deleteConversation(ORG, 's1', {
      userId: 'admin-1',
      ipAddress: '1.2.3.4',
    });
    // audit_log must never be hard-deleted as part of this cascade.
    expect(deleteCalls).not.toContain(auditLog);
    // Instead, its sessionId FK is nulled out so the row survives.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].table).toBe(auditLog);
    expect(updateCalls[0].values).toEqual({ sessionId: null });
  });
});

describe('setConversationHandled', () => {
  it('returns null and writes no audit row when no escalated session matched', async () => {
    updateQueue.push([]);
    const result = await setConversationHandled(ORG, 's1', true, { userId: 'admin-1' });
    expect(result).toBeNull();
    expect(insertCalls).toHaveLength(0);
  });

  it('stamps handledAt and audits with ids only', async () => {
    updateQueue.push([{ id: 's1' }]);
    const result = await setConversationHandled(ORG, 's1', true, {
      userId: 'admin-1',
      ipAddress: '1.2.3.4',
    });
    expect(result?.handledAt).toEqual(expect.any(String));
    expect((updateCalls[0].values as { handledAt: Date }).handledAt).toBeInstanceOf(Date);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].table).toBe(auditLog);
    expect(insertCalls[0].values).toEqual({
      organizationId: ORG,
      userId: 'admin-1',
      actorType: 'human',
      action: 'conversation_marked_handled',
      entity: 'customer_sessions',
      entityId: 's1',
      ipAddress: '1.2.3.4',
    });
  });

  it('reopens by clearing handledAt', async () => {
    updateQueue.push([{ id: 's1' }]);
    const result = await setConversationHandled(ORG, 's1', false, { userId: 'admin-1' });
    expect(result).toEqual({ handledAt: null });
    expect(updateCalls[0].values).toEqual({ handledAt: null });
    expect((insertCalls[0].values as { action: string }).action).toBe('conversation_reopened');
  });
});
