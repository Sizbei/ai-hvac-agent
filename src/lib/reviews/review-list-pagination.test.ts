import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mock state ──────────────────────────────────────────────────────
interface CapturedQuery {
  where: unknown;
  hasLimit: boolean;
}

const { selectQueue, captured, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const captured: CapturedQuery[] = [];

  const chain = (resolved: unknown, capture: CapturedQuery): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(resolved);
        }
        if (prop === 'where') {
          return (cond: unknown) => {
            capture.where = cond;
            return p;
          };
        }
        if (prop === 'limit') {
          return () => {
            capture.hasLimit = true;
            return p;
          };
        }
        // offset, orderBy, from, select — all return same proxy
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };

  return { selectQueue, captured, chain };
});

vi.mock('@/lib/db', () => {
  const make = () => {
    const capture: CapturedQuery = { where: undefined, hasLimit: false };
    captured.push(capture);
    return chain(selectQueue.shift() ?? [], capture);
  };
  return { db: { select: make, query: { communicationTemplates: { findFirst: vi.fn() } } } };
});

vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, orgId: string, ...conditions: unknown[]) => [
    { kind: 'tenant', orgId },
    ...conditions,
  ],
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ({ kind: 'eq', args: a }),
  and: (...a: unknown[]) => ({ kind: 'and', args: a }),
  desc: (c: unknown) => ({ kind: 'desc', col: c }),
  count: () => 'count',
  sql: vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => ({
    kind: 'sql',
    text: strings.join('?'),
    vals,
  })),
}));

vi.mock('@/lib/db/schema', () => ({
  customers: {},
  reviewRequests: {
    id: 'rr.id',
    organizationId: 'rr.org',
    serviceRequestId: 'rr.serviceRequestId',
    status: 'rr.status',
    rating: 'rr.rating',
    publicClicked: 'rr.publicClicked',
    sentAt: 'rr.sentAt',
    respondedAt: 'rr.respondedAt',
    createdAt: 'rr.createdAt',
    reviewTokenHash: 'rr.reviewTokenHash',
    customerId: 'rr.customerId',
    feedback: 'rr.feedback',
  },
  communicationTemplates: {
    organizationId: 'ct.org',
    triggerType: 'ct.triggerType',
    templateType: 'ct.templateType',
    isActive: 'ct.isActive',
    id: 'ct.id',
  },
}));

vi.mock('@/lib/crypto', () => ({ decrypt: (v: string) => v }));
vi.mock('@/lib/admin/org-config-queries', () => ({ getOrgConfig: vi.fn() }));
vi.mock('@/lib/communication/outbound-ledger', () => ({ claimOutboundOnce: vi.fn() }));
vi.mock('@/lib/communication/job-queue', () => ({ queueCommunicationJob: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock('server-only', () => ({}));

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

import { listReviews } from './review-queries';

const ORG = '00000000-0000-0000-0000-000000000001';

// Two selects per listReviews call: count then page rows.
const queuePage = (rows: unknown[] = []) => {
  selectQueue.push([{ n: 10 }]); // COUNT
  selectQueue.push(rows);         // page rows
};

describe('listReviews', () => {
  it('paginates: page query carries a LIMIT', async () => {
    queuePage();
    await listReviews(ORG);
    expect(captured.some((c) => c.hasLimit)).toBe(true);
  });

  it('is tenant-scoped: every WHERE includes the org id', async () => {
    queuePage();
    await listReviews(ORG);
    const wheres = captured.map((c) => JSON.stringify(c.where ?? ''));
    expect(wheres.every((w) => w.includes(ORG))).toBe(true);
  });

  it('returns { reviews, total } shape', async () => {
    queuePage([{
      id: 'rr-1',
      serviceRequestId: 'sr-1',
      status: 'sent',
      rating: null,
      publicClicked: false,
      sentAt: { toISOString: () => '2024-01-01T00:00:00.000Z' },
      respondedAt: null,
      createdAt: { toISOString: () => '2024-01-01T00:00:00.000Z' },
    }]);
    const result = await listReviews(ORG);
    expect(result).toHaveProperty('reviews');
    expect(result).toHaveProperty('total', 10);
    expect(Array.isArray(result.reviews)).toBe(true);
  });

  it('count and rows queries share the same WHERE', async () => {
    queuePage();
    await listReviews(ORG);
    // captured[0] = count query, captured[1] = rows query
    const countWhere = JSON.stringify(captured[0]?.where ?? '');
    const rowsWhere = JSON.stringify(captured[1]?.where ?? '');
    expect(countWhere).toBe(rowsWhere);
  });
});
