import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectQueue, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
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
  return { selectQueue, chain };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    selectDistinct: () => chain(selectQueue.shift() ?? []),
  },
}));

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, _orgId: string, ...conditions: unknown[]) =>
    conditions[0] ?? true,
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => a,
  sql: (...a: unknown[]) => a,
  count: () => 'count',
  desc: (c: unknown) => c,
}));

vi.mock('@/lib/db/schema', () => ({
  auditLog: {
    id: 'al.id',
    action: 'al.action',
    entity: 'al.entity',
    entityId: 'al.entityId',
    sessionId: 'al.sessionId',
    details: 'al.details',
    ipAddress: 'al.ipAddress',
    createdAt: 'al.createdAt',
    userId: 'al.userId',
    organizationId: 'al.org',
  },
  users: { id: 'u.id', name: 'u.name' },
}));

import { getAuditLog } from './audit-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

// The query issues three selects via Promise.all in this order:
//   1. count   2. rows   3. distinct actions
function seed(opts: {
  count: number;
  rows: unknown[];
  actions: string[];
}): void {
  selectQueue.push([{ value: opts.count }]);
  selectQueue.push(opts.rows);
  selectQueue.push(opts.actions.map((a) => ({ action: a })));
}

beforeEach(() => {
  selectQueue.length = 0;
});

describe('getAuditLog', () => {
  it('returns an empty page shape when there are no entries', async () => {
    seed({ count: 0, rows: [], actions: [] });
    const result = await getAuditLog(ORG, {});
    expect(result.total).toBe(0);
    expect(result.entries).toEqual([]);
    expect(result.actions).toEqual([]);
  });

  it('maps rows to entries with ISO timestamps and the distinct actions list', async () => {
    const when = new Date('2026-06-01T10:00:00.000Z');
    seed({
      count: 1,
      rows: [
        {
          id: 'a1',
          action: 'customer_updated',
          entity: 'customers',
          entityId: 'c1',
          sessionId: null,
          details: '{"fields":["email"]}',
          ipAddress: '203.0.113.7',
          createdAt: when,
          actorName: 'Admin One',
        },
      ],
      actions: ['customer_updated', 'request_status_changed'],
    });

    const result = await getAuditLog(ORG, {});
    expect(result.total).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toEqual({
      id: 'a1',
      action: 'customer_updated',
      entity: 'customers',
      entityId: 'c1',
      actorName: 'Admin One',
      sessionId: null,
      details: '{"fields":["email"]}',
      ipAddress: '203.0.113.7',
      createdAt: '2026-06-01T10:00:00.000Z',
    });
    expect(result.actions).toEqual([
      'customer_updated',
      'request_status_changed',
    ]);
  });

  it('surfaces a null actorName (system action) without throwing', async () => {
    const when = new Date('2026-06-02T00:00:00.000Z');
    seed({
      count: 1,
      rows: [
        {
          id: 'a2',
          action: 'session_escalated',
          entity: 'customer_sessions',
          entityId: 's1',
          sessionId: 's1',
          details: null,
          ipAddress: null,
          createdAt: when,
          actorName: null,
        },
      ],
      actions: ['session_escalated'],
    });

    const result = await getAuditLog(ORG, { action: 'session_escalated' });
    expect(result.entries[0].actorName).toBeNull();
    expect(result.entries[0].details).toBeNull();
  });
});
