import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The neon-http SQL aggregates are computed in the database, not in JS, so the
 * mock returns ALREADY-AGGREGATED rows (one row per select) exactly as the
 * driver would after running the SQL. We assert two things:
 *
 *   1. getSalesReport correctly INTERPRETS those rows (null-coalescing, net =
 *      gross - refunds, close-rate math).
 *   2. The QUERIES carry the right intent — we capture the column specs and
 *      where-conditions of each select so we can assert AR filters on
 *      state='open' and the estimate buckets reference expiresAt for lazy expiry.
 */

interface CapturedSelect {
  columns: Record<string, unknown>;
  where: unknown[];
  joins: unknown[];
}

const { selectQueue, captured, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const captured: CapturedSelect[] = [];

  // A chainable Proxy that records .select() columns + .where() args, then
  // resolves to the next queued result when awaited.
  const chain = (resolved: unknown, capture: CapturedSelect): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(resolved);
        }
        if (prop === 'where') {
          return (...args: unknown[]) => {
            capture.where = args;
            return p;
          };
        }
        if (prop === 'innerJoin' || prop === 'leftJoin') {
          return (...args: unknown[]) => {
            capture.joins.push(...args);
            return p;
          };
        }
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };

  return { selectQueue, captured, chain };
});

vi.mock('@/lib/db', () => ({
  db: {
    select: (columns: Record<string, unknown>) => {
      const capture: CapturedSelect = { columns: columns ?? {}, where: [], joins: [] };
      captured.push(capture);
      return chain(selectQueue.shift() ?? [], capture);
    },
  },
}));

// withTenant returns a tagged array so the test can see the org filter + the
// extra conditions a query passed in.
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, orgId: string, ...c: unknown[]) => [
    { kind: 'tenant', orgId },
    ...c,
  ],
}));

// drizzle-orm helpers return tagged structures so we can assert intent without a
// real SQL engine.
vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ({ kind: 'eq', args: a }),
  gte: (...a: unknown[]) => ({ kind: 'gte', args: a }),
  lte: (...a: unknown[]) => ({ kind: 'lte', args: a }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    kind: 'sql',
    text: strings.join('?'),
    values,
  }),
  sum: (col: unknown) => ({ kind: 'sum', col }),
  avg: (col: unknown) => ({ kind: 'avg', col }),
  count: (arg?: unknown) => ({ kind: 'count', arg }),
}));

vi.mock('@/lib/db/schema', () => ({
  estimates: {
    status: 'estimates.status',
    expiresAt: 'estimates.expiresAt',
    createdAt: 'estimates.createdAt',
    organizationId: 'estimates.org',
  },
  invoices: {
    state: 'invoices.state',
    totalCents: 'invoices.totalCents',
    amountPaidCents: 'invoices.amountPaidCents',
    createdAt: 'invoices.createdAt',
    organizationId: 'invoices.org',
  },
  payments: {
    amountCents: 'payments.amountCents',
    status: 'payments.status',
    createdAt: 'payments.createdAt',
    organizationId: 'payments.org',
  },
  refunds: {
    amountCents: 'refunds.amountCents',
    createdAt: 'refunds.createdAt',
    paymentId: 'refunds.paymentId',
    organizationId: 'refunds.org',
  },
  serviceRequests: {
    id: 'serviceRequests.id',
    leadSource: 'serviceRequests.leadSource',
    createdAt: 'serviceRequests.createdAt',
    organizationId: 'serviceRequests.org',
    locationId: 'serviceRequests.locationId',
    assignedTo: 'serviceRequests.assignedTo',
    status: 'serviceRequests.status',
  },
  customerLocations: {
    id: 'customerLocations.id',
    label: 'customerLocations.label',
    zone: 'customerLocations.zone',
    organizationId: 'customerLocations.org',
  },
  technicianTimeEntries: {
    technicianId: 'technicianTimeEntries.technicianId',
    serviceRequestId: 'technicianTimeEntries.serviceRequestId',
    minutes: 'technicianTimeEntries.minutes',
    organizationId: 'technicianTimeEntries.org',
  },
  reviewRequests: {
    serviceRequestId: 'reviewRequests.serviceRequestId',
    rating: 'reviewRequests.rating',
    organizationId: 'reviewRequests.org',
  },
  users: {
    id: 'users.id',
    name: 'users.name',
    organizationId: 'users.org',
  },
  leadSourceEnum: {
    enumValues: [
      'google',
      'facebook',
      'yelp',
      'referral',
      'repeat_customer',
      'website',
      'direct_mail',
      'other',
    ],
  },
}));

import {
  getSalesReport,
  getLeadSourceBreakdown,
  getLocationBreakdown,
  getTechnicianScorecards,
} from './reporting-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

// Selects run via Promise.all in this fixed order:
//   1 gross  2 refund  3 ar  4 estimates  5 invoices
interface Seed {
  gross: number | string | null;
  refund: number | string | null;
  ar: number | string | null;
  estimates: {
    created: number | string;
    sold: number | string;
    expired: number | string;
    open: number | string;
  };
  invoices: { created: number | string; paid: number | string };
}

function seed(s: Seed): void {
  selectQueue.push([{ value: s.gross }]);
  selectQueue.push([{ value: s.refund }]);
  selectQueue.push([{ value: s.ar }]);
  selectQueue.push([s.estimates]);
  selectQueue.push([s.invoices]);
}

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

function hasTag(value: unknown, predicate: (v: Record<string, unknown>) => boolean): boolean {
  if (Array.isArray(value)) return value.some((v) => hasTag(v, predicate));
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (predicate(obj)) return true;
    return Object.values(obj).some((v) => hasTag(v, predicate));
  }
  return false;
}

describe('getSalesReport', () => {
  it('coerces null sums to 0 (empty org)', async () => {
    seed({
      gross: null,
      refund: null,
      ar: null,
      estimates: { created: 0, sold: 0, expired: 0, open: 0 },
      invoices: { created: 0, paid: 0 },
    });
    const r = await getSalesReport(ORG);
    expect(r.grossCollectedCents).toBe(0);
    expect(r.refundedCents).toBe(0);
    expect(r.netCollectedCents).toBe(0);
    expect(r.outstandingArCents).toBe(0);
    expect(r.closeRatePct).toBe(0);
  });

  it('net collected = gross succeeded payments - refunds in period', async () => {
    seed({
      gross: '50000', // neon-http returns sums as strings
      refund: '12000',
      ar: 0,
      estimates: { created: 0, sold: 0, expired: 0, open: 0 },
      invoices: { created: 0, paid: 0 },
    });
    const r = await getSalesReport(ORG);
    expect(r.grossCollectedCents).toBe(50000);
    expect(r.refundedCents).toBe(12000);
    expect(r.netCollectedCents).toBe(38000);

    // The gross query must filter payments on status = 'succeeded'.
    const grossWhere = captured[0].where;
    expect(
      hasTag(
        grossWhere,
        (v) =>
          v.kind === 'eq' &&
          Array.isArray(v.args) &&
          (v.args as unknown[]).includes('payments.status') &&
          (v.args as unknown[]).includes('succeeded'),
      ),
    ).toBe(true);
  });

  it('outstanding AR sums only state=open invoice balances', async () => {
    // The DB would only sum 'open' invoices' (total - paid). A 'paid'/'refunded'
    // invoice contributes 0 because it is excluded by the WHERE state='open'.
    seed({
      gross: 0,
      refund: 0,
      ar: '7500', // sum(total - paid) over open invoices only
      estimates: { created: 0, sold: 0, expired: 0, open: 0 },
      invoices: { created: 3, paid: 2 },
    });
    const r = await getSalesReport(ORG);
    expect(r.outstandingArCents).toBe(7500);

    // The AR query (3rd select) must filter on state = 'open' and must NOT be
    // period-scoped (no gte/lte on createdAt — AR is a point-in-time snapshot).
    const arWhere = captured[2].where;
    expect(
      hasTag(
        arWhere,
        (v) =>
          v.kind === 'eq' &&
          Array.isArray(v.args) &&
          (v.args as unknown[]).includes('invoices.state') &&
          (v.args as unknown[]).includes('open'),
      ),
    ).toBe(true);
    expect(hasTag(arWhere, (v) => v.kind === 'gte' || v.kind === 'lte')).toBe(false);

    // And it sums (total - paid), not a naive total.
    const arCols = captured[2].columns as Record<string, unknown>;
    expect(
      hasTag(
        arCols.value,
        (v) =>
          v.kind === 'sql' &&
          typeof v.text === 'string' &&
          (v.text as string).includes('?') &&
          Array.isArray(v.values) &&
          (v.values as unknown[]).includes('invoices.totalCents') &&
          (v.values as unknown[]).includes('invoices.amountPaidCents'),
      ),
    ).toBe(true);
  });

  it('close rate = sold / (open + sold + expired); a past-expiry open estimate is bucketed expired by the query', async () => {
    // The query buckets a status='open' AND expiresAt<now estimate as EXPIRED,
    // so the DB returns it under `expired`, not `open`. Here: 4 sold, 5 open,
    // 1 expired => 4 / 10 = 40%.
    seed({
      gross: 0,
      refund: 0,
      ar: 0,
      estimates: { created: 10, sold: 4, expired: 1, open: 5 },
      invoices: { created: 0, paid: 0 },
    });
    const r = await getSalesReport(ORG);
    expect(r.estimatesSold).toBe(4);
    expect(r.estimatesOpen).toBe(5);
    expect(r.estimatesExpired).toBe(1);
    expect(r.closeRatePct).toBe(40);

    // The estimate select (4th) must reference expiresAt in its bucket CASE
    // expressions so a stale 'open' estimate lands in the expired bucket.
    const estCols = captured[3].columns as Record<string, unknown>;
    expect(
      hasTag(
        estCols.expired,
        (v) =>
          v.kind === 'sql' &&
          Array.isArray(v.values) &&
          (v.values as unknown[]).includes('estimates.expiresAt'),
      ),
    ).toBe(true);
  });

  it('rounds close rate to one decimal', async () => {
    // 1 sold of 3 decided = 33.333...% -> 33.3
    seed({
      gross: 0,
      refund: 0,
      ar: 0,
      estimates: { created: 3, sold: 1, expired: 1, open: 1 },
      invoices: { created: 0, paid: 0 },
    });
    const r = await getSalesReport(ORG);
    expect(r.closeRatePct).toBe(33.3);
  });
});

// getLeadSourceBreakdown runs 4 grouped selects via Promise.all, in this order:
//   1 leads  2 booked  3 gross payments  4 refunds
// Each returns rows of { source, value }. neon-http returns sums as strings.
interface SourceRow {
  source: string;
  value: number | string | null;
}
function seedLeadSource(s: {
  leads: SourceRow[];
  booked: SourceRow[];
  gross: SourceRow[];
  refunds: SourceRow[];
}): void {
  selectQueue.push(s.leads);
  selectQueue.push(s.booked);
  selectQueue.push(s.gross);
  selectQueue.push(s.refunds);
}

describe('getLeadSourceBreakdown', () => {
  it('returns a row for every enum value plus unknown, even with no data', async () => {
    seedLeadSource({ leads: [], booked: [], gross: [], refunds: [] });
    const rows = await getLeadSourceBreakdown(ORG);
    const sources = rows.map((r) => r.source).sort();
    expect(sources).toEqual(
      [
        'direct_mail',
        'facebook',
        'google',
        'other',
        'referral',
        'repeat_customer',
        'unknown',
        'website',
        'yelp',
      ].sort(),
    );
    // All zeroed out when there's no data.
    for (const r of rows) {
      expect(r.leads).toBe(0);
      expect(r.booked).toBe(0);
      expect(r.revenueCents).toBe(0);
      expect(r.closeRatePct).toBe(0);
    }
  });

  it('a zero-booking enum source still appears (not inner-joined away)', async () => {
    // yelp has leads but no bookings/revenue.
    seedLeadSource({
      leads: [{ source: 'yelp', value: 5 }],
      booked: [],
      gross: [],
      refunds: [],
    });
    const rows = await getLeadSourceBreakdown(ORG);
    const yelp = rows.find((r) => r.source === 'yelp');
    expect(yelp).toBeDefined();
    expect(yelp!.leads).toBe(5);
    expect(yelp!.booked).toBe(0);
    expect(yelp!.revenueCents).toBe(0);
    expect(yelp!.closeRatePct).toBe(0);
  });

  it('buckets NULL leadSource as "unknown" via coalesce in the query', async () => {
    // The driver already coalesced NULL -> 'unknown' (the SQL coalesce). We assert
    // the row lands under 'unknown' AND that the leads query carries a coalesce
    // over serviceRequests.leadSource so historical NULL rows are not dropped.
    seedLeadSource({
      leads: [{ source: 'unknown', value: 7 }],
      booked: [{ source: 'unknown', value: 2 }],
      gross: [],
      refunds: [],
    });
    const rows = await getLeadSourceBreakdown(ORG);
    const unknown = rows.find((r) => r.source === 'unknown');
    expect(unknown).toBeDefined();
    expect(unknown!.leads).toBe(7);
    expect(unknown!.booked).toBe(2);

    // The leads select (1st of this group) groups on a coalesce of leadSource.
    const leadsCols = captured[0].columns as Record<string, unknown>;
    expect(
      hasTag(
        leadsCols.source,
        (v) =>
          v.kind === 'sql' &&
          Array.isArray(v.values) &&
          (v.values as unknown[]).includes('serviceRequests.leadSource') &&
          (v.values as unknown[]).includes('unknown'),
      ),
    ).toBe(true);
  });

  it('attributes revenue (gross - refunds) per source and computes close rate', async () => {
    // google: 10 leads, 4 booked => 40%; revenue 50000 gross - 5000 refund = 45000.
    seedLeadSource({
      leads: [{ source: 'google', value: 10 }],
      booked: [{ source: 'google', value: 4 }],
      gross: [{ source: 'google', value: '50000' }], // neon-http sums as strings
      refunds: [{ source: 'google', value: '5000' }],
    });
    const rows = await getLeadSourceBreakdown(ORG);
    const google = rows.find((r) => r.source === 'google');
    expect(google).toBeDefined();
    expect(google!.leads).toBe(10);
    expect(google!.booked).toBe(4);
    expect(google!.revenueCents).toBe(45000);
    expect(google!.closeRatePct).toBe(40);
  });

  it('scopes the booked join on serviceRequests org + filters succeeded payments for revenue', async () => {
    seedLeadSource({
      leads: [{ source: 'google', value: 1 }],
      booked: [{ source: 'google', value: 1 }],
      gross: [{ source: 'google', value: '1000' }],
      refunds: [],
    });
    await getLeadSourceBreakdown(ORG);

    // The leads where (1st capture) must be tenant-scoped on serviceRequests.
    const leadsWhere = captured[0].where;
    expect(
      hasTag(
        leadsWhere,
        (v) => v.kind === 'tenant' && v.orgId === ORG,
      ),
    ).toBe(true);

    // The gross-revenue select (3rd capture) must constrain payments.status to
    // 'succeeded' somewhere in its join predicates.
    expect(
      hasTag(
        captured[2].joins,
        (v) =>
          v.kind === 'sql' &&
          typeof v.text === 'string' &&
          (v.text as string).includes('succeeded'),
      ),
    ).toBe(true);
  });
});

// getLocationBreakdown runs 4 selects via Promise.all, in this order:
//   1 jobs  2 revenue  3 rating  4 labels
interface LocRow {
  locationId: string;
  value: number | string | null;
}
function seedLocation(s: {
  jobs: LocRow[];
  revenue: LocRow[];
  rating: { locationId: string; value: number | string | null }[];
  labels: { id: string; label: string | null; zone: string | null }[];
}): void {
  selectQueue.push(s.jobs);
  selectQueue.push(s.revenue);
  selectQueue.push(s.rating);
  selectQueue.push(s.labels);
}

describe('getLocationBreakdown', () => {
  it('buckets NULL locationId under "unassigned" and resolves labels', async () => {
    seedLocation({
      jobs: [
        { locationId: 'loc-1', value: 4 },
        { locationId: 'unassigned', value: 2 },
      ],
      revenue: [{ locationId: 'loc-1', value: '90000' }],
      rating: [{ locationId: 'loc-1', value: '4.5' }],
      labels: [{ id: 'loc-1', label: 'Main St', zone: null }],
    });
    const rows = await getLocationBreakdown(ORG);

    const unassigned = rows.find((r) => r.locationId === 'unassigned');
    expect(unassigned).toBeDefined();
    expect(unassigned!.label).toBe('Unassigned');
    expect(unassigned!.jobs).toBe(2);
    expect(unassigned!.revenueCents).toBe(0);
    expect(unassigned!.avgRating).toBeNull();

    const loc1 = rows.find((r) => r.locationId === 'loc-1');
    expect(loc1!.label).toBe('Main St');
    expect(loc1!.jobs).toBe(4);
    expect(loc1!.revenueCents).toBe(90000);
    expect(loc1!.avgRating).toBe(4.5);
  });

  it('is tenant-scoped on every joined table (no cross-org leak)', async () => {
    seedLocation({
      jobs: [{ locationId: 'loc-1', value: 1 }],
      revenue: [{ locationId: 'loc-1', value: '100' }],
      rating: [],
      labels: [{ id: 'loc-1', label: 'X', zone: null }],
    });
    await getLocationBreakdown(ORG);

    // jobs where (capture 0) tenant-scoped on serviceRequests.
    expect(
      hasTag(captured[0].where, (v) => v.kind === 'tenant' && v.orgId === ORG),
    ).toBe(true);

    // revenue join (capture 1) carries the invoice org predicate.
    expect(
      hasTag(
        captured[1].joins,
        (v) =>
          v.kind === 'sql' &&
          typeof v.text === 'string' &&
          (v.text as string).includes('?') &&
          Array.isArray(v.values) &&
          (v.values as unknown[]).includes(ORG),
      ),
    ).toBe(true);

    // rating join (capture 2) carries the review_requests org predicate.
    expect(
      hasTag(
        captured[2].joins,
        (v) =>
          v.kind === 'sql' &&
          Array.isArray(v.values) &&
          (v.values as unknown[]).includes(ORG),
      ),
    ).toBe(true);

    // labels select (capture 3) tenant-scoped on customerLocations.
    expect(
      hasTag(captured[3].where, (v) => v.kind === 'tenant' && v.orgId === ORG),
    ).toBe(true);
  });

  it('a location with jobs but no reviews shows null rating (not a fake 0)', async () => {
    seedLocation({
      jobs: [{ locationId: 'loc-1', value: 3 }],
      revenue: [],
      rating: [], // no review rows
      labels: [{ id: 'loc-1', label: 'Depot', zone: null }],
    });
    const rows = await getLocationBreakdown(ORG);
    const loc1 = rows.find((r) => r.locationId === 'loc-1');
    expect(loc1!.avgRating).toBeNull();
    expect(loc1!.revenueCents).toBe(0);
  });
});

// getTechnicianScorecards runs 4 selects via Promise.all, in this order:
//   1 jobs(+name)  2 revenue  3 labor  4 rating
function seedTech(s: {
  jobs: {
    technicianId: string | null;
    name: string;
    assigned: number | string;
    completed: number | string;
  }[];
  revenue: { technicianId: string | null; value: number | string | null }[];
  labor: { technicianId: string | null; value: number | string | null }[];
  rating: { technicianId: string | null; value: number | string | null }[];
}): void {
  selectQueue.push(s.jobs);
  selectQueue.push(s.revenue);
  selectQueue.push(s.labor);
  selectQueue.push(s.rating);
}

describe('getTechnicianScorecards', () => {
  it('aggregates revenue, completed, labor hours, and rating per tech', async () => {
    seedTech({
      jobs: [{ technicianId: 'tech-1', name: 'Sam', assigned: 5, completed: 3 }],
      revenue: [{ technicianId: 'tech-1', value: '120000' }],
      labor: [{ technicianId: 'tech-1', value: 90 }], // 90 min -> 1.5h
      rating: [{ technicianId: 'tech-1', value: '4.8' }],
    });
    const rows = await getTechnicianScorecards(ORG);
    expect(rows).toHaveLength(1);
    const t = rows[0];
    expect(t.technicianId).toBe('tech-1');
    expect(t.name).toBe('Sam');
    expect(t.jobsAssigned).toBe(5);
    expect(t.jobsCompleted).toBe(3);
    expect(t.revenueCents).toBe(120000);
    expect(t.laborHours).toBe(1.5);
    expect(t.avgRating).toBe(4.8);
  });

  it('a tech with NO time entries shows null labor hours (not a fake 0)', async () => {
    seedTech({
      jobs: [{ technicianId: 'tech-2', name: 'Lee', assigned: 2, completed: 1 }],
      revenue: [],
      labor: [], // no time entries at all for this tech
      rating: [],
    });
    const rows = await getTechnicianScorecards(ORG);
    const t = rows.find((r) => r.technicianId === 'tech-2');
    expect(t).toBeDefined();
    expect(t!.laborHours).toBeNull();
    expect(t!.avgRating).toBeNull();
    expect(t!.revenueCents).toBe(0);
    expect(t!.jobsCompleted).toBe(1);
  });

  it('scopes every joined table by org on both sides', async () => {
    seedTech({
      jobs: [{ technicianId: 'tech-1', name: 'Sam', assigned: 1, completed: 1 }],
      revenue: [{ technicianId: 'tech-1', value: '100' }],
      labor: [{ technicianId: 'tech-1', value: 60 }],
      rating: [{ technicianId: 'tech-1', value: '5' }],
    });
    await getTechnicianScorecards(ORG);

    // jobs where (capture 0) tenant-scoped on serviceRequests.
    expect(
      hasTag(captured[0].where, (v) => v.kind === 'tenant' && v.orgId === ORG),
    ).toBe(true);
    // jobs join to users (capture 0) carries the users org predicate.
    expect(
      hasTag(
        captured[0].joins,
        (v) =>
          v.kind === 'sql' &&
          Array.isArray(v.values) &&
          (v.values as unknown[]).includes(ORG),
      ),
    ).toBe(true);

    // revenue join (capture 1) carries the invoice org predicate.
    expect(
      hasTag(
        captured[1].joins,
        (v) =>
          v.kind === 'sql' &&
          Array.isArray(v.values) &&
          (v.values as unknown[]).includes(ORG),
      ),
    ).toBe(true);

    // labor (capture 2): the time-entries select is tenant-scoped AND its join to
    // serviceRequests carries the request org predicate (both-sides scoping).
    expect(
      hasTag(captured[2].where, (v) => v.kind === 'tenant' && v.orgId === ORG),
    ).toBe(true);
    expect(
      hasTag(
        captured[2].joins,
        (v) =>
          v.kind === 'sql' &&
          Array.isArray(v.values) &&
          (v.values as unknown[]).includes(ORG),
      ),
    ).toBe(true);

    // rating join (capture 3) carries the review_requests org predicate.
    expect(
      hasTag(
        captured[3].joins,
        (v) =>
          v.kind === 'sql' &&
          Array.isArray(v.values) &&
          (v.values as unknown[]).includes(ORG),
      ),
    ).toBe(true);
  });

  it('drops requests with a NULL assignedTo (no tech to score)', async () => {
    seedTech({
      jobs: [
        { technicianId: 'tech-1', name: 'Sam', assigned: 1, completed: 1 },
        { technicianId: null, name: '', assigned: 9, completed: 0 },
      ],
      revenue: [],
      labor: [],
      rating: [],
    });
    const rows = await getTechnicianScorecards(ORG);
    expect(rows).toHaveLength(1);
    expect(rows[0].technicianId).toBe('tech-1');
  });
});
