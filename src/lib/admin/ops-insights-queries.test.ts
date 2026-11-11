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
    batch: (queries: unknown[]) => Promise.all(queries),
  },
}));

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, _orgId: string, ...c: unknown[]) => c[0] ?? true,
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => a,
  and: (...a: unknown[]) => a,
  sql: Object.assign((...a: unknown[]) => a, { join: (...a: unknown[]) => a }),
  count: () => 'count',
  gte: (...a: unknown[]) => a,
  inArray: (...a: unknown[]) => a,
  or: (...a: unknown[]) => a,
  isNotNull: (...a: unknown[]) => a,
  isNull: (...a: unknown[]) => a,
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
  requestStatusEnum: { enumValues: [] },
  holdReasonEnum: { enumValues: [] },
}));

vi.mock('./org-time-zone', () => ({
  getOrgTimeZone: async () => 'America/Chicago',
}));

import { getOpsInsights } from './ops-insights-queries';
import { SHOW_ALL, VISIBLE_ONLY } from './visibility';

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
    email?: string | null;
    total: number | string;
    active: number | string;
    completed: number | string;
  }[];
  hour?: { hour: number | string; value: number | string }[];
  cost?: { count: number | string; total: number | string; average: number | string };
  openImported?: number | string;
}): void {
  selectQueue.push(opts.issue);
  selectQueue.push(opts.urgency);
  selectQueue.push(opts.status);
  selectQueue.push([{ value: opts.last7 }]);
  selectQueue.push(opts.tech);
  selectQueue.push(opts.hour ?? []);
  selectQueue.push([opts.cost ?? { count: 0, total: 0, average: 0 }]);
  selectQueue.push([{ value: opts.openImported ?? 0 }]);
}

beforeEach(() => {
  selectQueue.length = 0;
});

describe('getOpsInsights', () => {
  it('returns an all-zero shape when there are no requests', async () => {
    seed({ issue: [], urgency: [], status: [], last7: 0, tech: [] });
    const r = await getOpsInsights(ORG, VISIBLE_ONLY);
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

  it("returns the org's time zone the hour buckets are in", async () => {
    seed({ issue: [], urgency: [], status: [], last7: 0, tech: [] });
    const r = await getOpsInsights(ORG, VISIBLE_ONLY);
    expect(r.timeZone).toBe('America/Chicago');
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
    const r = await getOpsInsights(ORG, VISIBLE_ONLY);
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
    const r = await getOpsInsights(ORG, VISIBLE_ONLY);
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
    const r = await getOpsInsights(ORG, VISIBLE_ONLY);
    expect(r.costStats.averageCents).toBe(0);
  });

  it('counts scheduled and on hold as open (the shared OPEN_STATUSES) and passes the imported share through', async () => {
    seed({
      issue: [],
      urgency: [],
      status: [
        { key: 'pending', value: '69' },
        { key: 'scheduled', value: '7' },
        { key: 'assigned', value: '24' },
        { key: 'in_progress', value: '17' },
        { key: 'on_hold', value: '2' },
        { key: 'completed', value: '125' },
      ],
      last7: 0,
      tech: [],
      openImported: '84',
    });
    const r = await getOpsInsights(ORG, VISIBLE_ONLY);
    expect(r.openRequests).toBe(119);
    expect(r.openImported).toBe(84);
    // open + completed + cancelled now equals the total.
    expect(r.openRequests + r.completedRequests + r.cancelledRequests).toBe(r.totalRequests);
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

    const r = await getOpsInsights(ORG, VISIBLE_ONLY);
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
    const r = await getOpsInsights(ORG, VISIBLE_ONLY);
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
    const r = await getOpsInsights(ORG, VISIBLE_ONLY);
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

  it('drops a retired demo technician from the load for an org viewer only', async () => {
    const tech = [
      { technicianId: 't1', technicianName: 'Alice', email: 'alice@spears.com', total: '5', active: '1', completed: '4' },
      { technicianId: 'd1', technicianName: 'Sarah Chen', email: 'sarah.chen@demo-hvac.com', total: '3', active: '3', completed: '0' },
      { technicianId: null, technicianName: null, email: null, total: '2', active: '2', completed: '0' },
    ];
    seed({ issue: [], urgency: [], status: [], last7: 0, tech });
    const org = await getOpsInsights(ORG, VISIBLE_ONLY);
    expect(org.technicianLoad.map((t) => t.technicianId)).toEqual([null, 't1']);
    expect(org.technicianLoad[0]).not.toHaveProperty('email');

    seed({ issue: [], urgency: [], status: [], last7: 0, tech });
    const owner = await getOpsInsights(ORG, SHOW_ALL);
    expect(owner.technicianLoad.map((t) => t.technicianId)).toEqual(['d1', null, 't1']);
  });
});
