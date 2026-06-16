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
      const capture: CapturedSelect = { columns: columns ?? {}, where: [] };
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
    organizationId: 'refunds.org',
  },
}));

import { getSalesReport } from './reporting-queries';

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
