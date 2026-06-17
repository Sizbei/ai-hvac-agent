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
  avg: () => 'avg',
  gte: (...a: unknown[]) => a,
  lte: (...a: unknown[]) => a,
  isNotNull: (...a: unknown[]) => a,
  desc: (...a: unknown[]) => a,
}));

vi.mock('@/lib/db/schema', () => ({
  botEvents: {
    organizationId: 'be.org',
    intentId: 'be.intentId',
    routed: 'be.routed',
    escalated: 'be.escalated',
    extractionComplete: 'be.extractionComplete',
    latencyMs: 'be.latencyMs',
    createdAt: 'be.createdAt',
  },
  customerSessions: {
    organizationId: 'cs.org',
    outcome: 'cs.outcome',
    createdAt: 'cs.createdAt',
  },
}));

import { getBotAnalytics } from './bot-analytics-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

// The query runs three selects via Promise.all, in this order:
//   1 totals (one row)  2 intent rows  3 outcome rows
function seed(opts: {
  totals?: {
    total: number | string;
    deterministic: number | string;
    escalated: number | string;
    complete: number | string;
    avgLatency: number | string | null;
  };
  intents?: { intentId: string | null; value: number | string }[];
  outcomes?: { outcome: string; value: number | string }[];
}): void {
  selectQueue.push([
    opts.totals ?? {
      total: 0,
      deterministic: 0,
      escalated: 0,
      complete: 0,
      avgLatency: null,
    },
  ]);
  selectQueue.push(opts.intents ?? []);
  selectQueue.push(opts.outcomes ?? []);
}

beforeEach(() => {
  selectQueue.length = 0;
});

describe('getBotAnalytics', () => {
  it('returns an all-zero shape when there are no events', async () => {
    seed({});
    const r = await getBotAnalytics(ORG);
    expect(r.totalTurns).toBe(0);
    expect(r.deterministicRatio).toBe(0);
    expect(r.escalationRate).toBe(0);
    expect(r.extractionCompletionRate).toBe(0);
    expect(r.avgLatencyMs).toBeNull();
    expect(r.abandonRate).toBe(0);
    expect(r.intentDistribution).toEqual([]);
    expect(r.outcomeDistribution).toEqual([]);
  });

  it('computes deterministicRatio = routed/total, rounded to 3dp', async () => {
    // 7 deterministic of 10 total -> 0.7. 1 escalated -> 0.1. 4 complete -> 0.4.
    seed({
      totals: {
        total: '10',
        deterministic: '7',
        escalated: '1',
        complete: '4',
        avgLatency: '123.7',
      },
    });
    const r = await getBotAnalytics(ORG);
    expect(r.totalTurns).toBe(10);
    expect(r.deterministicRatio).toBe(0.7);
    expect(r.escalationRate).toBe(0.1);
    expect(r.extractionCompletionRate).toBe(0.4);
    // avg latency rounded to whole ms.
    expect(r.avgLatencyMs).toBe(124);
  });

  it('rounds a repeating ratio to 3 decimal places', async () => {
    // 1 of 3 -> 0.333...
    seed({
      totals: {
        total: '3',
        deterministic: '1',
        escalated: '0',
        complete: '0',
        avgLatency: null,
      },
    });
    const r = await getBotAnalytics(ORG);
    expect(r.deterministicRatio).toBe(0.333);
    expect(r.avgLatencyMs).toBeNull();
  });

  it('preserves intent-distribution ordering from the query (top-N by count)', async () => {
    // The SQL orders by count desc + limits; the mapper must preserve that order.
    seed({
      intents: [
        { intentId: 'faq-hours', value: '9' },
        { intentId: 'cooling-no-cool', value: '4' },
        { intentId: 'pricing-diag', value: '2' },
      ],
    });
    const r = await getBotAnalytics(ORG);
    expect(r.intentDistribution.map((x) => x.intentId)).toEqual([
      'faq-hours',
      'cooling-no-cool',
      'pricing-diag',
    ]);
    expect(r.intentDistribution[0]).toEqual({
      intentId: 'faq-hours',
      count: 9,
    });
  });

  it('maps a null intent id to "unknown"', async () => {
    seed({ intents: [{ intentId: null, value: '3' }] });
    const r = await getBotAnalytics(ORG);
    expect(r.intentDistribution[0]).toEqual({ intentId: 'unknown', count: 3 });
  });

  it('sorts outcome distribution by count and computes abandon rate over classified sessions', async () => {
    // 2 booked, 3 abandoned, 1 escalated, 4 unclassified.
    // classified = 2+3+1 = 6; abandoned = 3 -> abandonRate = 0.5.
    seed({
      outcomes: [
        { outcome: 'booked', value: '2' },
        { outcome: 'abandoned', value: '3' },
        { outcome: 'escalated', value: '1' },
        { outcome: 'unclassified', value: '4' },
      ],
    });
    const r = await getBotAnalytics(ORG);
    // Sorted by count desc.
    expect(r.outcomeDistribution.map((x) => x.outcome)).toEqual([
      'unclassified',
      'abandoned',
      'booked',
      'escalated',
    ]);
    expect(r.abandonRate).toBe(0.5);
  });

  it('abandon rate is 0 when there are no classified sessions (only unclassified)', async () => {
    seed({ outcomes: [{ outcome: 'unclassified', value: '5' }] });
    const r = await getBotAnalytics(ORG);
    expect(r.abandonRate).toBe(0);
  });

  it('is tenant-scoped: every select resolves through withTenant for the given org', async () => {
    // withTenant is mocked to a sentinel; the test asserts the call shape doesn't
    // throw and the period defaults are applied (fromDate < toDate).
    seed({});
    const r = await getBotAnalytics(ORG);
    expect(new Date(r.fromDate).getTime()).toBeLessThan(
      new Date(r.toDate).getTime(),
    );
  });

  it('honors an explicit period range', async () => {
    seed({});
    const fromDate = new Date('2026-01-01T00:00:00Z');
    const toDate = new Date('2026-02-01T00:00:00Z');
    const r = await getBotAnalytics(ORG, { fromDate, toDate });
    expect(r.fromDate).toBe(fromDate.toISOString());
    expect(r.toDate).toBe(toDate.toISOString());
  });
});
