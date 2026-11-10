import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const getAdminSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => getAdminSession(),
}));
// The route reads the viewer; derive it from the session mock (an org user).
vi.mock('@/lib/auth/viewer', () => ({
  getViewerContext: async () => {
    const session = await getAdminSession();
    return session ? { session, showHidden: false } : null;
  },
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
import { GET, POST } from './route';
import {
  collectedThisMonthCents,
  createInvoiceFromSoldEstimate,
  getInvoiceSummaryStats,
  listInvoices,
} from '@/lib/admin/invoice-queries';
import { logAudit } from '@/lib/admin/audit';

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

  it('reads the list and every money tile with the same viewer', async () => {
    getAdminSession.mockResolvedValue({
      userId: 'u1', organizationId: 'org-1', email: 'a@x.com', name: 'A', role: 'admin',
    });
    const res = await GET(new NextRequest('https://app.example.com/api/admin/invoices'));
    expect(res.status).toBe(200);
    const viewer = expect.objectContaining({ showHidden: false });
    expect(listInvoices).toHaveBeenLastCalledWith('org-1', expect.any(Object), viewer);
    expect(getInvoiceSummaryStats).toHaveBeenLastCalledWith('org-1', viewer);
    expect(collectedThisMonthCents).toHaveBeenLastCalledWith('org-1', viewer);
  });
});

describe('POST /api/admin/invoices (generate from an estimate)', () => {
  const EST = '7f1a9a4e-0f43-4b8e-9d0a-2c3a5b6c7d8e';
  function post() {
    return new NextRequest('https://app.example.com/api/admin/invoices', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://app.example.com' },
      body: JSON.stringify({ estimateId: EST }),
    });
  }
  beforeEach(() => {
    getAdminSession.mockResolvedValue({
      userId: 'u1', organizationId: 'org-1', email: 'a@x.com', name: 'A', role: 'admin',
    });
    vi.mocked(logAudit).mockReset().mockResolvedValue(undefined);
  });

  it('says created: true (201) only for a new invoice', async () => {
    vi.mocked(createInvoiceFromSoldEstimate).mockResolvedValue({ ok: true, invoiceId: 'inv-1', created: true });
    const res = await POST(post());
    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({ invoiceId: 'inv-1', created: true });
    expect(logAudit).toHaveBeenCalledOnce();
  });

  it('returns the existing invoice as created: false (200), with no audit row', async () => {
    vi.mocked(createInvoiceFromSoldEstimate).mockResolvedValue({ ok: true, invoiceId: 'inv-1', created: false });
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ invoiceId: 'inv-1', created: false });
    expect(logAudit).not.toHaveBeenCalled();
  });
});
