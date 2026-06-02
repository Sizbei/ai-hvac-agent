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
  db: { select: () => chain(selectQueue.shift() ?? []) },
}));

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, _orgId: string, ...c: unknown[]) => c[0] ?? true,
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => a,
  and: (...a: unknown[]) => a,
  sql: (...a: unknown[]) => a,
  count: () => 'count',
  gte: (...a: unknown[]) => a,
}));

vi.mock('@/lib/db/schema', () => ({
  serviceRequests: {
    issueType: 'sr.issueType',
    urgency: 'sr.urgency',
    status: 'sr.status',
    assignedTo: 'sr.assignedTo',
    createdAt: 'sr.createdAt',
    organizationId: 'sr.org',
  },
  users: { id: 'u.id', name: 'u.name', organizationId: 'u.org' },
}));

import { getOpsInsights } from './ops-insights-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

// The query runs five selects via Promise.all, in this order:
//   1 issue  2 urgency  3 status  4 last7  5 techLoad
function seed(opts: {
  issue: { key: string; value: number | string }[];
  urgency: { key: string; value: number | string }[];
  status: { key: string; value: number | string }[];
  last7: number | string;
  tech: {
    technicianId: string | null;
    technicianName: string | null;
    total: number | string;
    active: number | string;
    completed: number | string;
  }[];
}): void {
  selectQueue.push(opts.issue);
  selectQueue.push(opts.urgency);
  selectQueue.push(opts.status);
  selectQueue.push([{ value: opts.last7 }]);
  selectQueue.push(opts.tech);
}

beforeEach(() => {
  selectQueue.length = 0;
});

describe('getOpsInsights', () => {
  it('returns an all-zero shape when there are no requests', async () => {
    seed({ issue: [], urgency: [], status: [], last7: 0, tech: [] });
    const r = await getOpsInsights(ORG);
    expect(r.totalRequests).toBe(0);
    expect(r.openRequests).toBe(0);
    expect(r.completedRequests).toBe(0);
    expect(r.byIssueType).toEqual([]);
    expect(r.technicianLoad).toEqual([]);
  });

  it('derives totals from the status breakdown and coerces string aggregates', async () => {
    seed({
      issue: [
        { key: 'cooling_not_working', value: '2' },
        { key: 'heating_not_working', value: '5' },
      ],
      urgency: [{ key: 'high', value: '4' }],
      // neon-http returns counts as strings.
      status: [
        { key: 'pending', value: '3' },
        { key: 'assigned', value: '1' },
        { key: 'in_progress', value: '1' },
        { key: 'completed', value: '2' },
        { key: 'cancelled', value: '1' },
      ],
      last7: '6',
      tech: [],
    });

    const r = await getOpsInsights(ORG);
    expect(r.totalRequests).toBe(8); // 3+1+1+2+1
    expect(r.openRequests).toBe(5); // pending+assigned+in_progress
    expect(r.completedRequests).toBe(2);
    expect(r.cancelledRequests).toBe(1);
    expect(r.requestsLast7Days).toBe(6);
  });

  it('sorts issue-type breakdown by count descending', async () => {
    seed({
      issue: [
        { key: 'a', value: 1 },
        { key: 'b', value: 9 },
        { key: 'c', value: 4 },
      ],
      urgency: [],
      status: [],
      last7: 0,
      tech: [],
    });
    const r = await getOpsInsights(ORG);
    expect(r.byIssueType.map((x) => x.key)).toEqual(['b', 'c', 'a']);
  });

  it('maps technician load and sorts by active workload, unassigned bucket included', async () => {
    seed({
      issue: [],
      urgency: [],
      status: [],
      last7: 0,
      tech: [
        { technicianId: 't1', technicianName: 'Alice', total: '5', active: '1', completed: '4' },
        { technicianId: 't2', technicianName: 'Bob', total: '3', active: '3', completed: '0' },
        { technicianId: null, technicianName: null, total: '2', active: '2', completed: '0' },
      ],
    });
    const r = await getOpsInsights(ORG);
    // Sorted by active desc: Bob(3), unassigned(2), Alice(1).
    expect(r.technicianLoad.map((t) => t.technicianName)).toEqual([
      'Bob',
      null,
      'Alice',
    ]);
    expect(r.technicianLoad[0]).toEqual({
      technicianId: 't2',
      technicianName: 'Bob',
      total: 3,
      active: 3,
      completed: 0,
    });
  });
});
