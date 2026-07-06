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
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...a: unknown[]) => ({ kind: 'eq', args: a }),
}));

vi.mock('@/lib/db/schema', () => ({
  organizationSettings: {
    companyName: 'organizationSettings.companyName',
    businessInfo: 'organizationSettings.businessInfo',
    organizationId: 'organizationSettings.organizationId',
  },
}));

import { getInvoiceOrgIdentity } from './invoice-queries';

beforeEach(() => {
  selectQueue.length = 0;
});

describe('getInvoiceOrgIdentity', () => {
  it('fills company phone from businessInfo', async () => {
    selectQueue.push([{ companyName: 'Spears Services', businessInfo: { phone: '(423) 555-0100' } }]);
    const id = await getInvoiceOrgIdentity('org-1');
    expect(id.companyName).toBe('Spears Services');
    expect(id.phone).toBe('(423) 555-0100');
    expect(id.address).toBeNull();
  });

  it('phone is null when businessInfo has none', async () => {
    selectQueue.push([{ companyName: 'X', businessInfo: {} }]);
    expect((await getInvoiceOrgIdentity('org-1')).phone).toBeNull();
  });
});
