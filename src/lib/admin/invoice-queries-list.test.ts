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
    update: () => {
      const capture: CapturedSelect = { columns: {}, where: [], joins: [] };
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
  or: (...a: unknown[]) => ({ kind: 'or', args: a }),
  gte: (...a: unknown[]) => ({ kind: 'gte', args: a }),
  gt: (...a: unknown[]) => ({ kind: 'gt', args: a }),
  lt: (...a: unknown[]) => ({ kind: 'lt', args: a }),
  lte: (...a: unknown[]) => ({ kind: 'lte', args: a }),
  sum: (col: unknown) => ({ kind: 'sum', col }),
  count: () => ({ kind: 'count' }),
  asc: (col: unknown) => ({ kind: 'asc', col }),
  desc: (col: unknown) => ({ kind: 'desc', col }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    kind: 'sql',
    text: strings.join('?'),
    values,
  }),
  isNull: (c: unknown) => ({ kind: 'isNull', c }),
  isNotNull: (c: unknown) => ({ kind: 'isNotNull', c }),
  inArray: (c: unknown, arr: unknown) => ({ kind: 'inArray', c, arr }),
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
    issuedAt: 'invoices.issuedAt',
    dueDate: 'invoices.dueDate',
    lastReminderSentAt: 'invoices.lastReminderSentAt',
    fieldpulseInvoiceId: 'invoices.fieldpulseInvoiceId',
    hcpInvoiceId: 'invoices.hcpInvoiceId',
    fieldpulseData: 'invoices.fieldpulseData',
    organizationId: 'invoices.org',
    updatedAt: 'invoices.updatedAt',
  },
  customers: {
    id: 'customers.id',
    nameEncrypted: 'customers.nameEncrypted',
    organizationId: 'customers.org',
  },
  invoiceStateEnum: { enumValues: ['draft', 'open', 'paid', 'void', 'refunded'] },
  payments: {
    amountCents: 'payments.amountCents',
    status: 'payments.status',
    createdAt: 'payments.createdAt',
    organizationId: 'payments.org',
    fieldpulsePaymentId: 'payments.fieldpulsePaymentId',
  },
  communicationJobs: {
    organizationId: 'cj.org',
    triggerType: 'cj.triggerType',
    channel: 'cj.channel',
    status: 'cj.status',
    templateVariables: 'cj.templateVariables',
    createdAt: 'cj.createdAt',
    completedAt: 'cj.completedAt',
  },
}));

vi.mock('@/lib/crypto', () => ({
  decrypt: (c: string) => `dec(${c})`,
}));

beforeEach(() => {
  selectQueue.length = 0;
  captured.length = 0;
});

import { listInvoices, collectedThisMonthCents, voidInvoice, listInvoiceReminders } from './invoice-queries';

describe('listInvoices', () => {
  it('returns invoices with decrypted customer name + lastReminderSentAt, org-scoped', async () => {
    // listInvoices now makes 3 db.select calls: sourceCounts, count, rows
    selectQueue.push([]); // sourceCounts
    selectQueue.push([{ n: 1 }]); // count
    selectQueue.push([
      { id: 'i1', state: 'open', totalCents: 5000, amountPaidCents: 0,
        customerId: 'c1', serviceRequestId: 'sr1', createdAt: new Date('2026-06-01'),
        issuedAt: null, dueDate: null,
        fieldpulseInvoiceId: null, hcpInvoiceId: null, fieldpulseData: null,
        nameEncrypted: 'ENC', lastReminderSentAt: new Date('2026-06-20') },
    ]); // rows
    const result = await listInvoices('org-1');
    const rows = result.invoices;
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
  it('scopes to the org, succeeded status, the month window, and excludes FP payments', async () => {
    selectQueue.push([{ value: '0' }]);
    await collectedThisMonthCents('org-1', new Date('2026-07-06T12:00:00Z'));
    const where = JSON.stringify(captured[0].where);
    expect(where).toContain('succeeded');
    expect(where).toContain('org-1');
    // month window predicates present
    expect(where).toContain('gte');
    expect(where).toContain('lt');
    // FP payment guard: isNull(payments.fieldpulsePaymentId)
    expect(where).toContain('isNull');
    expect(where).toContain('payments.fieldpulsePaymentId');
  });
});

describe('voidInvoice', () => {
  const openNative = { state: 'open', amountPaidCents: 0, fieldpulseInvoiceId: null, hcpInvoiceId: null };
  it('voids a native, unpaid, open invoice (atomic claim returns a row)', async () => {
    selectQueue.push([openNative]);      // the classify read
    selectQueue.push([{ id: 'i1' }]);    // the guarded UPDATE ... RETURNING
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: true });
  });
  it('refuses a synced invoice', async () => {
    selectQueue.push([{ ...openNative, fieldpulseInvoiceId: 'fp1' }]);
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: false, reason: 'synced_read_only' });
  });
  it('refuses an invoice with payments', async () => {
    selectQueue.push([{ ...openNative, amountPaidCents: 5000 }]);
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: false, reason: 'has_payments' });
  });
  it('refuses a paid/terminal invoice', async () => {
    selectQueue.push([{ ...openNative, state: 'paid' }]);
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: false, reason: 'not_voidable' });
  });
  it('returns not_found when the invoice is absent', async () => {
    selectQueue.push([]);
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: false, reason: 'not_found' });
  });
  it('returns not_voidable when the atomic claim loses the race (no row returned)', async () => {
    selectQueue.push([openNative]); // classify passes
    selectQueue.push([]);            // UPDATE returns nothing
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: false, reason: 'not_voidable' });
  });
});

describe('listInvoiceReminders', () => {
  it('maps rows using completedAt when present, falls back to createdAt, newest first', async () => {
    const completedAt = new Date('2026-07-01T10:00:00Z');
    const createdAt = new Date('2026-07-01T09:00:00Z');
    const createdAtOnly = new Date('2026-06-28T08:00:00Z');
    selectQueue.push([
      { channel: 'sms', status: 'completed', completedAt, createdAt },
      { channel: 'sms', status: 'completed', completedAt: null, createdAt: createdAtOnly },
    ]);
    const rows = await listInvoiceReminders('org-1', 'inv-abc');
    expect(rows).toHaveLength(2);
    // First row: uses completedAt
    expect(rows[0].at).toEqual(completedAt);
    expect(rows[0].channel).toBe('sms');
    expect(rows[0].status).toBe('completed');
    // Second row: falls back to createdAt
    expect(rows[1].at).toEqual(createdAtOnly);
  });

  it('returns [] when no reminder jobs exist for the invoice', async () => {
    selectQueue.push([]);
    const rows = await listInvoiceReminders('org-1', 'inv-none');
    expect(rows).toEqual([]);
  });

  it('where-clause contains invoice_overdue, org-1, and the invoiceId filter', async () => {
    selectQueue.push([]);
    await listInvoiceReminders('org-1', 'inv-abc');
    const where = JSON.stringify(captured[captured.length - 1].where);
    expect(where).toContain('invoice_overdue');
    expect(where).toContain('org-1');
    // A regression that drops the per-invoice filter (returning every org
    // reminder) must fail here, not just the mapping tests.
    expect(where).toContain('inv-abc');
  });
});

describe('listInvoices — unreminded filter', () => {
  it('adds isNull(lastReminderSentAt) condition when unreminded=true', async () => {
    selectQueue.push([]); // sourceCounts
    selectQueue.push([{ n: 0 }]); // count
    selectQueue.push([]); // rows
    await listInvoices('org-1', { unreminded: true });
    // Find the count query's WHERE (captured[1]) — all extra conditions are present there too
    const where = JSON.stringify(captured[1].where);
    expect(where).toContain('isNull');
    expect(where).toContain('lastReminderSentAt');
  });

  it('does NOT add an isNull condition when unreminded is false or absent', async () => {
    selectQueue.push([]);
    selectQueue.push([{ n: 0 }]);
    selectQueue.push([]);
    await listInvoices('org-1', { unreminded: false });
    const where = JSON.stringify(captured[1].where);
    // The only isNull present should be from the source filter (which isn't active here),
    // so there should be no isNull for lastReminderSentAt
    expect(where).not.toContain('lastReminderSentAt');
  });
});

describe('listInvoices — balance range filters', () => {
  it('adds gte condition when minCents is a valid non-negative integer', async () => {
    selectQueue.push([]);
    selectQueue.push([{ n: 0 }]);
    selectQueue.push([]);
    await listInvoices('org-1', { minCents: 5000 });
    const where = JSON.stringify(captured[1].where);
    expect(where).toContain('"gte"');
    expect(where).toContain('5000');
  });

  it('adds lte condition when maxCents is a valid non-negative integer', async () => {
    selectQueue.push([]);
    selectQueue.push([{ n: 0 }]);
    selectQueue.push([]);
    await listInvoices('org-1', { maxCents: 20000 });
    const where = JSON.stringify(captured[1].where);
    expect(where).toContain('"lte"');
    expect(where).toContain('20000');
  });

  it('adds both gte and lte when both bounds are provided', async () => {
    selectQueue.push([]);
    selectQueue.push([{ n: 0 }]);
    selectQueue.push([]);
    await listInvoices('org-1', { minCents: 1000, maxCents: 50000 });
    const where = JSON.stringify(captured[1].where);
    expect(where).toContain('"gte"');
    expect(where).toContain('"lte"');
    expect(where).toContain('1000');
    expect(where).toContain('50000');
  });

  it('ignores minCents when NaN or negative', async () => {
    selectQueue.push([]);
    selectQueue.push([{ n: 0 }]);
    selectQueue.push([]);
    // NaN comes in as undefined from the API layer guard, but test the query layer with -1
    await listInvoices('org-1', { minCents: -1 });
    const where = JSON.stringify(captured[1].where);
    // Only the tenant condition should be present, no gte
    expect(where).not.toContain('"gte"');
  });

  it('ignores maxCents when NaN or negative', async () => {
    selectQueue.push([]);
    selectQueue.push([{ n: 0 }]);
    selectQueue.push([]);
    await listInvoices('org-1', { maxCents: -500 });
    const where = JSON.stringify(captured[1].where);
    expect(where).not.toContain('"lte"');
  });
});
