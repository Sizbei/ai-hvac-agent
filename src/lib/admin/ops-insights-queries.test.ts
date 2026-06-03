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
  serviceHistory: { cost: 'sh.cost', organizationId: 'sh.org' },
}));

import { getOpsInsights } from './ops-insights-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

// The query runs seven selects via Promise.all, in this order:
//   1 issue  2 urgency  3 status  4 last7  5 techLoad  6 hour  7 cost
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
  hour?: { hour: number | string; value: number | string }[];
  cost?: { count: number | string; total: number | string; average: number | string };
}): void {
  selectQueue.push(opts.issue);
  selectQueue.push(opts.urgency);
  selectQueue.push(opts.status);
  selectQueue.push([{ value: opts.last7 }]);
  selectQueue.push(opts.tech);
  selectQueue.push(opts.hour ?? []);
  selectQueue.push([opts.cost ?? { count: 0, total: 0, average: 0 }]);
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
    // The hour histogram is always dense (24 entries), all zero here.
    expect(r.requestsByHour).toHaveLength(24);
    expect(r.requestsByHour.every((h) => h.count === 0)).toBe(true);
    expect(r.requestsByHour[0]).toEqual({ hour: 0, count: 0 });
    expect(r.costStats).toEqual({ count: 0, totalCents: 0, averageCents: 0 });
  });

  it('backfills missing hours to zero and coerces string hour keys', async () => {
    seed({
      issue: [],
      urgency: [],
      status: [],
      last7: 0,
      tech: [],
      // neon-http returns the extracted hour + count as strings.
      hour: [
        { hour: '9', value: '5' },
        { hour: '14', value: '3' },
      ],
    });
    const r = await getOpsInsights(ORG);
    expect(r.requestsByHour).toHaveLength(24);
    expect(r.requestsByHour[9]).toEqual({ hour: 9, count: 5 });
    expect(r.requestsByHour[14]).toEqual({ hour: 14, count: 3 });
    expect(r.requestsByHour[0].count).toBe(0);
    // Total across the histogram equals the sum of the seeded buckets.
    const sum = r.requestsByHour.reduce((acc, h) => acc + h.count, 0);
    expect(sum).toBe(8);
  });

  it('aggregates service costs and rounds the average to whole cents', async () => {
    seed({
      issue: [],
      urgency: [],
      status: [],
      last7: 0,
      tech: [],
      // 3 jobs, total 30000c ($300), avg 10000.5c → rounds to 10001.
      cost: { count: '3', total: '30000', average: '10000.5' },
    });
    const r = await getOpsInsights(ORG);
    expect(r.costStats).toEqual({
      count: 3,
      totalCents: 30000,
      averageCents: 10001,
    });
  });

  it('reports a zero average when no costs are recorded even if sum coerces', async () => {
    seed({
      issue: [],
      urgency: [],
      status: [],
      last7: 0,
      tech: [],
      cost: { count: '0', total: '0', average: '0' },
    });
    const r = await getOpsInsights(ORG);
    expect(r.costStats.averageCents).toBe(0);
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
