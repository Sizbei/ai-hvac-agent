import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const getAdminSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => getAdminSession(),
}));

vi.mock('@/lib/admin/invoice-queries', () => ({
  listInvoices: vi.fn().mockResolvedValue({ invoices: [], total: 0, sourceCounts: {} }),
  getInvoiceSummaryStats: vi.fn().mockResolvedValue({}),
  collectedThisMonthCents: vi.fn().mockResolvedValue(0),
  createInvoiceFromSoldEstimate: vi.fn(),
  INVOICE_SORT_KEYS: new Set<string>(),
}));
vi.mock('@/lib/db/schema', () => ({
  invoiceStateEnum: { enumValues: ['draft', 'sent', 'paid', 'void'] },
}));
vi.mock('@/lib/payments/card-enabled', () => ({ cardPaymentsEnabled: () => false }));
vi.mock('@/lib/admin/audit', () => ({ logAudit: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: {
    adminRead: { maxRequests: 60, windowMs: 60_000 },
    adminMutation: { maxRequests: 30, windowMs: 60_000 },
  },
}));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from 'next/server';
import { GET } from './route';

beforeEach(() => {
  getAdminSession.mockReset();
});

describe('GET /api/admin/invoices caching', () => {
  it('is never stored by the browser, so a payment or reminder shows at once', async () => {
    getAdminSession.mockResolvedValue({
      userId: 'u1',
      organizationId: 'org-1',
      email: 'a@x.com',
      name: 'A',
      role: 'admin',
    });
    const res = await GET(new NextRequest('https://app.example.com/api/admin/invoices'));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
