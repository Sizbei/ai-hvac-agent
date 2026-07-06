import { describe, it, expect, vi, beforeEach } from 'vitest';

interface CapturedSelect {
  columns: Record<string, unknown>;
  where: unknown[];
  joins: unknown[];
}

const { selectQueue, captured, chain } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const captured: CapturedSelect[] = [];

  // A chainable Proxy that records .select() columns + .where()/.leftJoin() args,
  // then resolves to the next queued result when awaited.
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

// withTenant returns a tagged array so the test can see the org filter.
vi.mock('@/lib/db/tenant', () => ({
  withTenant: (_table: unknown, orgId: string, ...c: unknown[]) => [
    { kind: 'tenant', orgId },
    ...c,
  ],
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ({ kind: 'eq', args: a }),
  and: (...a: unknown[]) => ({ kind: 'and', args: a }),
  gte: (...a: unknown[]) => ({ kind: 'gte', args: a }),
  lt: (...a: unknown[]) => ({ kind: 'lt', args: a }),
  sum: (col: unknown) => ({ kind: 'sum', col }),
  desc: (col: unknown) => ({ kind: 'desc', col }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    kind: 'sql',
    text: strings.join('?'),
    values,
  }),
}));

vi.mock('@/lib/db/schema', () => ({
  invoices: {
    id: 'invoices.id',
    state: 'invoices.state',
    totalCents: 'invoices.totalCents',
    amountPaidCents: 'invoices.amountPaidCents',
    customerId: 'invoices.customerId',
    serviceRequestId: 'invoices.serviceRequestId',
    createdAt: 'invoices.createdAt',
    lastReminderSentAt: 'invoices.lastReminderSentAt',
    fieldpulseInvoiceId: 'invoices.fieldpulseInvoiceId',
    hcpInvoiceId: 'invoices.hcpInvoiceId',
    organizationId: 'invoices.org',
  },
  customers: {
    id: 'customers.id',
    nameEncrypted: 'customers.nameEncrypted',
    organizationId: 'customers.org',
  },
  payments: {
    amountCents: 'payments.amountCents',
    status: 'payments.status',
    createdAt: 'payments.createdAt',
    organizationId: 'payments.org',
  },
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: (c: string) => `dec(${c})`,
}));

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

import { listInvoices, collectedThisMonthCents } from './invoice-queries';

describe('listInvoices', () => {
  it('returns invoices with decrypted customer name + lastReminderSentAt, org-scoped', async () => {
    selectQueue.push([
      { id: 'i1', state: 'open', totalCents: 5000, amountPaidCents: 0,
        customerId: 'c1', serviceRequestId: 'sr1', createdAt: new Date('2026-06-01'),
        fieldpulseInvoiceId: null, hcpInvoiceId: null,
        nameEncrypted: 'ENC', lastReminderSentAt: new Date('2026-06-20') },
    ]);
    const rows = await listInvoices('org-1');
    expect(rows[0].customerName).toBe('dec(ENC)');
    expect(rows[0].lastReminderSentAt).toEqual(new Date('2026-06-20'));
    expect(rows[0].syncedSource).toBeNull();
    // customers join is org-scoped (defense in depth)
    const joins = JSON.stringify(captured.flatMap(c => c.joins));
    expect(joins).toContain('customers');
    // verifies the org predicate is in the join, not just the table reference
    expect(joins).toContain('"org-1"');
  });
});

describe('collectedThisMonthCents', () => {
  it('sums succeeded payments for the current month (coerces neon string)', async () => {
    selectQueue.push([{ value: '124500' }]); // neon returns sum() as a string
    const total = await collectedThisMonthCents('org-1', new Date('2026-07-06T12:00:00Z'));
    expect(total).toBe(124500);
  });
  it('returns 0 when there are no payments', async () => {
    selectQueue.push([{ value: null }]);
    expect(
      await collectedThisMonthCents('org-1', new Date('2026-07-06T12:00:00Z')),
    ).toBe(0);
  });
  it('scopes to the org, succeeded status, and the month window', async () => {
    selectQueue.push([{ value: '0' }]);
    await collectedThisMonthCents('org-1', new Date('2026-07-06T12:00:00Z'));
    const where = JSON.stringify(captured[0].where);
    expect(where).toContain('succeeded');
    expect(where).toContain('org-1');
    // month window predicates present
    expect(where).toContain('gte');
    expect(where).toContain('lt');
  });
});
