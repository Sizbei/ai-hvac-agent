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
  asc: (col: unknown) => ({ kind: 'asc', col }),
  desc: (col: unknown) => ({ kind: 'desc', col }),
  inArray: (col: unknown, vals: unknown) => ({ kind: 'inArray', col, vals }),
  lt: (col: unknown, val: unknown) => ({ kind: 'lt', col, val }),
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
    subtotalCents: 'invoices.subtotalCents',
    taxCents: 'invoices.taxCents',
    totalCents: 'invoices.totalCents',
    amountPaidCents: 'invoices.amountPaidCents',
    customerId: 'invoices.customerId',
    serviceRequestId: 'invoices.serviceRequestId',
    estimateId: 'invoices.estimateId',
    createdAt: 'invoices.createdAt',
    lastReminderSentAt: 'invoices.lastReminderSentAt',
    fieldpulseInvoiceId: 'invoices.fieldpulseInvoiceId',
    hcpInvoiceId: 'invoices.hcpInvoiceId',
    organizationId: 'invoices.org',
  },
  invoiceLineItems: {
    id: 'invoiceLineItems.id',
    name: 'invoiceLineItems.name',
    quantity: 'invoiceLineItems.quantity',
    unitPriceCents: 'invoiceLineItems.unitPriceCents',
    costCents: 'invoiceLineItems.costCents',
    lineTotalCents: 'invoiceLineItems.lineTotalCents',
    invoiceId: 'invoiceLineItems.invoiceId',
    organizationId: 'invoiceLineItems.org',
  },
  payments: {
    id: 'payments.id',
    amountCents: 'payments.amountCents',
    status: 'payments.status',
    isDeposit: 'payments.isDeposit',
    createdAt: 'payments.createdAt',
    invoiceId: 'payments.invoiceId',
    organizationId: 'payments.org',
  },
  refunds: {
    id: 'refunds.id',
    paymentId: 'refunds.paymentId',
    amountCents: 'refunds.amountCents',
    reason: 'refunds.reason',
    createdAt: 'refunds.createdAt',
    organizationId: 'refunds.org',
  },
  customers: {
    id: 'customers.id',
    nameEncrypted: 'customers.nameEncrypted',
    addressEncrypted: 'customers.addressEncrypted',
    phoneEncrypted: 'customers.phoneEncrypted',
    organizationId: 'customers.org',
  },
  serviceRequests: {
    id: 'serviceRequests.id',
    assignedTo: 'serviceRequests.assignedTo',
    scheduledDate: 'serviceRequests.scheduledDate',
    organizationId: 'serviceRequests.org',
  },
  users: {
    id: 'users.id',
    name: 'users.name',
    organizationId: 'users.org',
  },
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: (c: string) => `dec(${c})`,
}));

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

import { getInvoiceDetailById } from './invoice-queries';

describe('getInvoiceDetailById', () => {
  it('returns decrypted customer identity + technician + service date on the detail view', async () => {
    // Queue: invoice row (with joined fields), then empty lineItems, empty payments
    selectQueue.push([
      {
        id: 'i1',
        state: 'open',
        subtotalCents: 5000,
        taxCents: 250,
        totalCents: 5250,
        amountPaidCents: 0,
        customerId: 'c1',
        serviceRequestId: null,
        estimateId: null,
        createdAt: new Date('2026-06-01'),
        fieldpulseInvoiceId: null,
        hcpInvoiceId: null,
        nameEncrypted: 'EN',
        addressEncrypted: 'EA',
        phoneEncrypted: 'EP',
        technicianName: 'Davis Reed',
        serviceDate: new Date('2026-04-22'),
        lastReminderSentAt: new Date('2026-07-03'),
      },
    ]);
    selectQueue.push([]); // lineItems
    selectQueue.push([]); // payments
    const v = await getInvoiceDetailById('org-1', 'i1');
    expect(v?.customerName).toBe('dec(EN)');
    expect(v?.customerAddress).toBe('dec(EA)');
    expect(v?.customerPhone).toBe('dec(EP)');
    expect(v?.technicianName).toBe('Davis Reed');
    expect(v?.serviceDate).toEqual(new Date('2026-04-22'));
    expect(v?.lastReminderSentAt).toEqual(new Date('2026-07-03'));

    // Assert that each LEFT JOIN is scoped to the organization (defense in depth).
    // If a join's organizationId predicate is removed, this test will fail. Specifically
    // check for the org column + org id pairing in each join's AND condition.
    const joinsStr = JSON.stringify(captured[0].joins);
    expect(joinsStr).toContain('"customers.org"');
    expect(joinsStr).toContain('"serviceRequests.org"');
    expect(joinsStr).toContain('"users.org"');
    // Verify org-1 appears (in the predicates, paired with each org column)
    const joinsMatch = joinsStr.match(/"org-1"/g);
    expect(joinsMatch?.length).toBe(3); // One for each join's org predicate
  });
});
