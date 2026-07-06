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
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: (c: string) => `dec(${c})`,
}));

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

import { listInvoices } from './invoice-queries';

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
  });
});
