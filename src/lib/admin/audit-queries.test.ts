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

const { withTenantSpy } = vi.hoisted(() => ({
  withTenantSpy: vi.fn((_table: unknown, _orgId: string, ...conditions: unknown[]) =>
    conditions[0] ?? true,
  ),
}));
vi.mock('@/lib/db/tenant', () => ({ withTenant: withTenantSpy }));

const { eqSpy, gteSpy } = vi.hoisted(() => ({
  eqSpy: vi.fn((...a: unknown[]) => a),
  gteSpy: vi.fn((...a: unknown[]) => ['gte', ...a]),
}));

vi.mock('drizzle-orm', () => ({
  eq: eqSpy,
  gte: gteSpy,
  and: (...a: unknown[]) => a,
  sql: Object.assign((...a: unknown[]) => a, { raw: (text: string) => ['raw', text] }),
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
  users: { id: 'u.id', name: 'u.name', organizationId: 'u.org' },
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
  eqSpy.mockClear();
  gteSpy.mockClear();
  withTenantSpy.mockClear();
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

  it('(A12) scopes the actor-name join to the session org, not just userId', async () => {
    // A row's userId can point at a user in a DIFFERENT org (e.g.
    // org_provisioned, written by platform provisioning). The join must
    // require users.organizationId = the session's org too, or a foreign
    // actor's real name leaks into this org's audit-log page.
    seed({ count: 0, rows: [], actions: [] });
    await getAuditLog(ORG, {});
    expect(eqSpy).toHaveBeenCalledWith('u.org', ORG);
  });

  it('without a cutoff, adds no created_at bound', async () => {
    seed({ count: 0, rows: [], actions: [] });
    await getAuditLog(ORG, {});
    expect(gteSpy).not.toHaveBeenCalled();
  });

  it('with a cutoff, bounds the count, the rows and the action list by created_at >= cutoff', async () => {
    const since = new Date('2026-11-10T17:30:00.000Z');
    seed({ count: 0, rows: [], actions: [] });
    await getAuditLog(ORG, { action: 'customer_updated', since });
    expect(gteSpy).toHaveBeenCalledWith('al.createdAt', since);
    // count + rows share one where clause; the action list builds its own.
    expect(withTenantSpy).toHaveBeenCalledTimes(2);
    for (const call of withTenantSpy.mock.calls) {
      expect(call[1]).toBe(ORG);
      expect(call.slice(2)).toContainEqual(['gte', 'al.createdAt', since]);
    }
    // The action list stays unfiltered by action (dropdown shows every option).
    const actionListCall = withTenantSpy.mock.calls.find((c) => c.length === 3);
    expect(actionListCall).toBeDefined();
  });

  it('visibleOnly drops invoice_synced entries whose invoice is hidden, from the count, the rows and the action list', async () => {
    seed({ count: 0, rows: [], actions: [] });
    await getAuditLog(ORG, { visibleOnly: true });
    expect(withTenantSpy).toHaveBeenCalledTimes(2);
    for (const call of withTenantSpy.mock.calls) {
      const text = JSON.stringify(call.slice(2));
      expect(text).toContain("invoice_synced");
      expect(text).toContain('FROM invoices i WHERE i.id = ');
      expect(text).toContain('i.hidden_from_org');
      // the invoice lookup is scoped to the session org
      expect(call.slice(2).flat(3)).toContain(ORG);
    }
  });

  it('without visibleOnly, adds no invoice filter', async () => {
    seed({ count: 0, rows: [], actions: [] });
    await getAuditLog(ORG, {});
    for (const call of withTenantSpy.mock.calls) {
      expect(JSON.stringify(call.slice(2))).not.toContain('invoice_synced');
    }
  });
});
