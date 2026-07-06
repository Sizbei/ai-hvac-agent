import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Hoisted mocks ──────────────────────────────────────────────────
const {
  mockGetAdminSession,
  mockGetInvoiceCustomerId,
  mockGeneratePortalToken,
  mockSlidingWindow,
} = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockGetInvoiceCustomerId: vi.fn(),
  mockGeneratePortalToken: vi.fn(),
  mockSlidingWindow: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => mockGetAdminSession(),
}));

vi.mock('@/lib/rate-limit', () => ({
  slidingWindow: (...a: unknown[]) => mockSlidingWindow(...a),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

vi.mock('@/lib/admin/invoice-queries', () => ({
  getInvoiceCustomerId: (...a: unknown[]) => mockGetInvoiceCustomerId(...a),
}));

vi.mock('@/lib/portal/portal-queries', () => ({
  generatePortalToken: (...a: unknown[]) => mockGeneratePortalToken(...a),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/admin/invoices/[id]/pay-link/route';

process.env.NEXT_PUBLIC_APP_URL = 'https://app.test';

const mockSession = {
  userId: 'u1',
  organizationId: 'org-1',
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'admin' as const,
};

function req() {
  return new NextRequest('http://t/api/admin/invoices/i1/pay-link', { method: 'POST' });
}

function ctx() {
  return { params: Promise.resolve({ id: 'i1' }) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAdminSession.mockResolvedValue(mockSession);
  mockSlidingWindow.mockReturnValue({ allowed: true });
  mockGetInvoiceCustomerId.mockResolvedValue('cust-1');
  mockGeneratePortalToken.mockResolvedValue('TOK');
});

describe('POST /api/admin/invoices/[id]/pay-link', () => {
  it('mints a pay link for the invoice customer', async () => {
    const res = await POST(req(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.payLink).toBe('https://app.test/portal/TOK');
  });

  it('401 when not admin', async () => {
    mockGetAdminSession.mockResolvedValueOnce(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(401);
  });

  it('404 when invoice has no customer', async () => {
    mockGetInvoiceCustomerId.mockResolvedValueOnce(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });

  it('429 when rate limited', async () => {
    mockSlidingWindow.mockReturnValueOnce({ allowed: false });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(429);
  });

  it('404 when portal token cannot be minted', async () => {
    mockGeneratePortalToken.mockResolvedValueOnce(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });
});
