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

const getCustomers = vi.fn();
const createCustomer = vi.fn();
const findNativeContactClash = vi.fn();
vi.mock('@/lib/admin/crm-queries', () => ({
  getCustomers: (...a: unknown[]) => getCustomers(...a),
  createCustomer: (...a: unknown[]) => createCustomer(...a),
  findNativeContactClash: (...a: unknown[]) => findNativeContactClash(...a),
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
import { GET, POST } from './route';

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
  createCustomer.mockReset();
  findNativeContactClash.mockReset();
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
      expect.objectContaining({ showHidden: false }),
    );
  });
});

describe('POST /api/admin/customers duplicate contact', () => {
  const post = () =>
    POST(
      new NextRequest('https://app.example.com/api/admin/customers', {
        method: 'POST',
        body: JSON.stringify({ name: 'Pat', email: 'pat@example.com' }),
      }),
    );
  const uniqueViolation = Object.assign(new Error('dup'), { cause: { code: '23505' } });

  it('links the clashing customer the viewer can see', async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createCustomer.mockRejectedValue(uniqueViolation);
    findNativeContactClash.mockResolvedValue({ id: 'cust-1', archived: false });
    const res = await post();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('CUSTOMER_ALREADY_EXISTS');
    expect(body.error.details).toEqual({ customerId: 'cust-1', archived: false });
    // The lookup gets the viewer, so it skips customers hidden from them.
    expect(findNativeContactClash).toHaveBeenCalledWith(
      SESSION.organizationId,
      { email: 'pat@example.com', phone: null },
      expect.objectContaining({ showHidden: false }),
    );
  });

  it('gives generic copy with no link when the clash is hidden from the viewer', async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createCustomer.mockRejectedValue(uniqueViolation);
    // What the filtered lookup returns for a hidden customer.
    findNativeContactClash.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
    expect(body.error).toEqual({
      code: 'CUSTOMER_ALREADY_EXISTS',
      message: 'A customer with this email or phone already exists',
    });
  });
});
