import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state ─────────────────────────────────────────────
const { selectQueue, batchMock, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const batchMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
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
  sessionChannelEnum: { enumValues: ['web', 'phone'] },
  messages: { sessionId: 'messages.sid', organizationId: 'messages.org' },
  serviceRequests: {
    id: 'sr.id',
    sessionId: 'sr.sid',
    organizationId: 'sr.org',
    referenceNumber: 'sr.ref',
  },
  serviceHistory: { serviceRequestId: 'sh.srid', organizationId: 'sh.org' },
  auditLog: { sessionId: 'audit.sid', organizationId: 'audit.org' },
}));

import { deleteConversation, getConversationById } from './conversation-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  selectQueue.length = 0;
  batchMock.mockClear();
  batchMock.mockResolvedValue([]);
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
    selectQueue.push([]); // service request

    const detail = await getConversationById(ORG, 's1');
    expect(detail).not.toBeNull();
    expect(detail?.channel).toBe('phone');
    expect(detail?.runningSummary).toBe('Caller reported no heat at 5 Oak St.');
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
    // service_history + service_requests + audit_log + messages + session
    // deletes, then the conversation_deleted audit insert.
    const statements = batchMock.mock.calls[0][0] as unknown[];
    expect(statements).toHaveLength(6);
  });
});
