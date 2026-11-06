import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const getAdminSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => getAdminSession(),
}));

const getCustomers = vi.fn();
vi.mock('@/lib/admin/crm-queries', () => ({
  getCustomers: (...a: unknown[]) => getCustomers(...a),
  createCustomer: vi.fn(),
  findNativeContactClash: vi.fn(),
}));

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

const SESSION = {
  userId: '11111111-1111-1111-1111-111111111111',
  organizationId: '00000000-0000-0000-0000-000000000001',
  email: 'a@x.com',
  name: 'A',
  role: 'admin' as const,
};

beforeEach(() => {
  getAdminSession.mockReset();
  getCustomers.mockReset();
});

describe('GET /api/admin/customers caching', () => {
  it('is never stored by the browser, so search reflects an edit or archive at once', async () => {
    getAdminSession.mockResolvedValue(SESSION);
    getCustomers.mockResolvedValue({ customers: [], total: 0, propertyTypes: [] });
    const res = await GET(
      new NextRequest('https://app.example.com/api/admin/customers?search=Quillon'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(getCustomers).toHaveBeenCalledWith(
      SESSION.organizationId,
      expect.objectContaining({ search: 'Quillon' }),
    );
  });
});
