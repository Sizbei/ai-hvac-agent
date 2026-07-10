import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * getOperationsMetrics fetches small per-row sets from neon-http and reduces
 * them (median / avg / window-bucketing) in JS. The DB mock returns those rows
 * exactly as the driver would; we assert:
 *   1. the JS reduction is correct (median vs avg, current/previous split by the
 *      event anchor, null/no-data handling, cents coercion), and
 *   2. the queries carry the right intent (native-only paid filter, aging on
 *      state='open').
 *
 * Timestamps mix string (as neon returns sql min()/max()) and Date (as drizzle
 * returns a timestamp COLUMN) to exercise the toDate() coercion on both.
 */

interface CapturedSelect {
  columns: Record<string, unknown>;
  where: unknown[];
  joins: unknown[];
}

const { selectQueue, captured, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const captured: CapturedSelect[] = [];
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

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, orgId: string, ...c: unknown[]) => [
    { kind: 'tenant', orgId },
    ...c,
  ],
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ({ kind: 'eq', args: a }),
  gte: (...a: unknown[]) => ({ kind: 'gte', args: a }),
  lt: (...a: unknown[]) => ({ kind: 'lt', args: a }),
  isNull: (col: unknown) => ({ kind: 'isNull', col }),
  isNotNull: (col: unknown) => ({ kind: 'isNotNull', col }),
  or: (...a: unknown[]) => ({ kind: 'or', args: a }),
  count: (arg?: unknown) => ({ kind: 'count', arg }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    kind: 'sql',
    text: strings.join('?'),
    values,
  }),
}));

vi.mock('@/lib/db/schema', () => ({
  serviceRequests: {
    id: 'serviceRequests.id',
    createdAt: 'serviceRequests.createdAt',
    organizationId: 'serviceRequests.org',
    fieldpulseJobId: 'serviceRequests.fieldpulseJobId',
    hcpJobId: 'serviceRequests.hcpJobId',
  },
  requestStatusEvents: {
    at: 'requestStatusEvents.at',
    toStatus: 'requestStatusEvents.toStatus',
    actorType: 'requestStatusEvents.actorType',
    serviceRequestId: 'requestStatusEvents.serviceRequestId',
    organizationId: 'requestStatusEvents.org',
  },
  technicianTimeEntries: {
    minutes: 'technicianTimeEntries.minutes',
    clockOutAt: 'technicianTimeEntries.clockOutAt',
    organizationId: 'technicianTimeEntries.org',
  },
  invoices: {
    id: 'invoices.id',
    state: 'invoices.state',
    totalCents: 'invoices.totalCents',
    amountPaidCents: 'invoices.amountPaidCents',
    createdAt: 'invoices.createdAt',
    issuedAt: 'invoices.issuedAt',
    organizationId: 'invoices.org',
    fieldpulseInvoiceId: 'invoices.fieldpulseInvoiceId',
    hcpInvoiceId: 'invoices.hcpInvoiceId',
  },
  payments: {
    invoiceId: 'payments.invoiceId',
    status: 'payments.status',
    createdAt: 'payments.createdAt',
    organizationId: 'payments.org',
  },
}));

import { getOperationsMetrics } from './operations-metrics-queries';

const ORG = 'org-1';
const FROM = new Date('2026-06-01T00:00:00Z');
const TO = new Date('2026-07-01T00:00:00Z'); // 30-day span → prevFrom 2026-05-02

/**
 * Queue the 9 select results in the exact order getOperationsMetrics issues them:
 * inProgress, assigned, paid, onSite, aging (native), syncedAging,
 * jobsCurrent (native), jobsPrevious (native), importedJobsCurrent.
 */
function queueAll(rows: {
  inProgress?: unknown[];
  assigned?: unknown[];
  paid?: unknown[];
  onSite?: unknown[];
  aging?: unknown[];
  syncedAging?: unknown[];
  jobsCurrent?: unknown[];
  jobsPrevious?: unknown[];
  importedJobsCurrent?: unknown[];
}) {
  selectQueue.push(
    rows.inProgress ?? [],
    rows.assigned ?? [],
    rows.paid ?? [],
    rows.onSite ?? [{ avgMinutes: null }],
    rows.aging ?? [{ b0: '0', b30: '0', b60: '0' }],
    rows.syncedAging ?? [{ totalCents: '0', count: '0' }],
    rows.jobsCurrent ?? [{ value: '0' }],
    rows.jobsPrevious ?? [{ value: '0' }],
    rows.importedJobsCurrent ?? [{ value: '0' }],
  );
}

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

describe('getOperationsMetrics', () => {
  it('computes the full scorecard from aggregated rows', async () => {
    queueAll({
      inProgress: [
        { firstAt: '2026-06-10T00:00:00Z', createdAt: new Date('2026-06-09T00:00:00Z') }, // 86400 cur
        { firstAt: '2026-06-20T00:00:00Z', createdAt: new Date('2026-06-18T00:00:00Z') }, // 172800 cur
        { firstAt: '2026-05-10T00:00:00Z', createdAt: new Date('2026-05-09T00:00:00Z') }, // 86400 prev
      ],
      assigned: [
        { serviceRequestId: 'r-h1', actorType: 'human', firstAt: '2026-06-05T00:00:00Z', createdAt: new Date('2026-06-04T00:00:00Z') }, // 86400 cur
        { serviceRequestId: 'r-h2', actorType: 'human', firstAt: '2026-06-15T00:00:00Z', createdAt: new Date('2026-06-14T00:00:00Z') }, // 86400 cur
        { serviceRequestId: 'r-h3', actorType: 'human', firstAt: '2026-05-10T00:00:00Z', createdAt: new Date('2026-05-09T00:00:00Z') }, // 86400 prev
        { serviceRequestId: 'r-s1', actorType: 'system', firstAt: '2026-06-05T00:00:42Z', createdAt: new Date('2026-06-05T00:00:00Z') }, // 42 cur
      ],
      paid: [
        { firstAt: '2026-06-20T00:00:00Z', createdAt: new Date('2026-06-14T00:00:00Z') }, // 518400 cur
        { firstAt: '2026-05-10T00:00:00Z', createdAt: new Date('2026-05-04T00:00:00Z') }, // 518400 prev
      ],
      onSite: [{ avgMinutes: '95' }],
      aging: [{ b0: '4200', b30: '1100', b60: '600' }],
      jobsCurrent: [{ value: '142' }],
      jobsPrevious: [{ value: '127' }],
    });

    const m = await getOperationsMetrics(ORG, { fromDate: FROM, toDate: TO });

    // Response time = MEDIAN of current [86400, 172800] and previous [86400].
    expect(m.responseTimeSeconds.current).toBe(129600);
    expect(m.responseTimeSeconds.previous).toBe(86400);
    // On-site: 95 min → seconds.
    expect(m.onSiteSeconds).toBe(5700);
    // Time to paid = AVG.
    expect(m.timeToPaidSeconds.current).toBe(518400);
    expect(m.timeToPaidSeconds.previous).toBe(518400);
    // AR aging + total.
    expect(m.arAging).toEqual({
      bucket0to30Cents: 4200,
      bucket31to60Cents: 1100,
      bucket60PlusCents: 600,
      totalOutstandingCents: 5900,
    });
    // Jobs booked.
    expect(m.jobsBooked).toEqual({ current: 142, previous: 127 });
    // First response: human AVG = 86400 (current & previous); system = 42.
    expect(m.firstResponseHumanSeconds.current).toBe(86400);
    expect(m.firstResponseHumanSeconds.previous).toBe(86400);
    expect(m.firstResponseSystemSeconds).toBe(42);
    expect(m.rangeDays).toBe(30);
  });

  it('attributes first response to the EARLIEST assignment — a later human reassignment of an auto-dispatched job does not inflate the human headline', async () => {
    queueAll({
      assigned: [
        // Same request: system assigned it in 5s, a dispatcher reassigned 6h later.
        { serviceRequestId: 'r-x', actorType: 'system', firstAt: '2026-06-05T00:00:05Z', createdAt: new Date('2026-06-05T00:00:00Z') },
        { serviceRequestId: 'r-x', actorType: 'human', firstAt: '2026-06-05T06:00:00Z', createdAt: new Date('2026-06-05T00:00:00Z') },
      ],
    });
    const m = await getOperationsMetrics(ORG, { fromDate: FROM, toDate: TO });
    // The system assignment won (earliest) → the 6h human reassignment is NOT
    // counted as a first response.
    expect(m.firstResponseHumanSeconds.current).toBeNull();
    expect(m.firstResponseSystemSeconds).toBe(5);
  });

  it('does not count an in-window reassignment as first response when the true first assignment predates the window', async () => {
    // With no SQL lower bound, the query returns the pre-window first event too.
    queueAll({
      assigned: [
        // True first assignment (system) BEFORE prevFrom (2026-05-02).
        { serviceRequestId: 'r-stale', actorType: 'system', firstAt: '2026-04-15T00:00:00Z', createdAt: new Date('2026-04-14T00:00:00Z') },
        // Dispatcher reassigns it INSIDE the current window.
        { serviceRequestId: 'r-stale', actorType: 'human', firstAt: '2026-06-10T00:00:00Z', createdAt: new Date('2026-04-14T00:00:00Z') },
      ],
    });
    const m = await getOperationsMetrics(ORG, { fromDate: FROM, toDate: TO });
    // Earliest-overall winner is the pre-window system event → it falls outside
    // both windows → NOTHING is counted. The in-window human reassignment does
    // NOT inflate the human headline.
    expect(m.firstResponseHumanSeconds.current).toBeNull();
    expect(m.firstResponseSystemSeconds).toBeNull();
  });

  it('returns null (not 0) for metrics with no qualifying rows', async () => {
    queueAll({}); // all defaults: empty event/paid rows, avgMinutes null, zero counts
    const m = await getOperationsMetrics(ORG, { fromDate: FROM, toDate: TO });

    expect(m.responseTimeSeconds.current).toBeNull();
    expect(m.responseTimeSeconds.previous).toBeNull();
    expect(m.timeToPaidSeconds.current).toBeNull();
    expect(m.firstResponseHumanSeconds.current).toBeNull();
    expect(m.firstResponseSystemSeconds).toBeNull();
    expect(m.onSiteSeconds).toBeNull();
    // Counts and cents are real zeros, not null.
    expect(m.jobsBooked).toEqual({ current: 0, previous: 0 });
    expect(m.arAging.totalOutstandingCents).toBe(0);
  });

  it('drops negative-duration rows (clock skew / bad data)', async () => {
    queueAll({
      inProgress: [
        { firstAt: '2026-06-10T00:00:00Z', createdAt: new Date('2026-06-11T00:00:00Z') }, // negative → dropped
        { firstAt: '2026-06-20T00:00:00Z', createdAt: new Date('2026-06-19T00:00:00Z') }, // 86400 kept
      ],
    });
    const m = await getOperationsMetrics(ORG, { fromDate: FROM, toDate: TO });
    // Only the valid row survives → median of a single value.
    expect(m.responseTimeSeconds.current).toBe(86400);
  });

  it('excludes an event whose anchor falls outside both windows', async () => {
    queueAll({
      inProgress: [
        { firstAt: '2026-04-01T00:00:00Z', createdAt: new Date('2026-03-31T00:00:00Z') }, // before prevFrom → excluded
      ],
    });
    const m = await getOperationsMetrics(ORG, { fromDate: FROM, toDate: TO });
    expect(m.responseTimeSeconds.current).toBeNull();
    expect(m.responseTimeSeconds.previous).toBeNull();
  });

  it('scopes the paid-invoice query to native invoices (synced FP/HCP excluded)', async () => {
    queueAll({});
    await getOperationsMetrics(ORG, { fromDate: FROM, toDate: TO });

    // 3rd select is the paid-invoice query. Its where args flatten to include the
    // isNull guards on both external-id columns and state='paid'.
    const paidWhere = JSON.stringify(captured[2]?.where ?? []);
    expect(paidWhere).toContain('isNull');
    expect(paidWhere).toContain('invoices.fieldpulseInvoiceId');
    expect(paidWhere).toContain('invoices.hcpInvoiceId');
    expect(paidWhere).toContain('paid');
    // ...and bounded by payment date so it doesn't scan all paid history.
    expect(paidWhere).toContain('gte');
    expect(paidWhere).toContain('payments.createdAt');

    // 5th select is native AR aging — scoped to open invoices with IS NULL guards.
    const agingWhere = JSON.stringify(captured[4]?.where ?? []);
    expect(agingWhere).toContain('open');
    expect(agingWhere).toContain('isNull');
    expect(agingWhere).toContain('invoices.fieldpulseInvoiceId');
    expect(agingWhere).toContain('invoices.hcpInvoiceId');

    // 6th select is synced AR aging — OR(isNotNull(fieldpulseInvoiceId), isNotNull(hcpInvoiceId))
    // so both FP-synced and HCP-synced open invoices are included.
    const syncedAgingWhere = JSON.stringify(captured[5]?.where ?? []);
    expect(syncedAgingWhere).toContain('isNotNull');
    expect(syncedAgingWhere).toContain('invoices.fieldpulseInvoiceId');
    expect(syncedAgingWhere).toContain('invoices.hcpInvoiceId');

    // 7th select is native jobsCurrent — IS NULL guards on both job id columns.
    const jobsCurrentWhere = JSON.stringify(captured[6]?.where ?? []);
    expect(jobsCurrentWhere).toContain('isNull');
    expect(jobsCurrentWhere).toContain('serviceRequests.fieldpulseJobId');
    expect(jobsCurrentWhere).toContain('serviceRequests.hcpJobId');

    // 9th select is importedJobsCurrent — OR(isNotNull(fieldpulseJobId), isNotNull(hcpJobId))
    // so both FP-synced and HCP-synced jobs are included in the imported count.
    const importedJobsWhere = JSON.stringify(captured[8]?.where ?? []);
    expect(importedJobsWhere).toContain('isNotNull');
    expect(importedJobsWhere).toContain('serviceRequests.fieldpulseJobId');
    expect(importedJobsWhere).toContain('serviceRequests.hcpJobId');
  });

  it('AR aging buckets reference coalesce(issuedAt, createdAt) — not bare createdAt', async () => {
    queueAll({});
    await getOperationsMetrics(ORG, { fromDate: FROM, toDate: TO });

    // 5th select is native AR aging. The sql`` column expressions must reference
    // issuedAt so that native invoices without an issued date fall back to createdAt
    // while any row with issued_at set (e.g. future migration) is bucketed correctly.
    const agingColumns = JSON.stringify(captured[4]?.columns ?? {});
    expect(agingColumns).toContain('invoices.issuedAt');
    expect(agingColumns).toContain('invoices.createdAt');
  });
});
