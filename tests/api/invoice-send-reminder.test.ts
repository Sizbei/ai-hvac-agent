import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Hoisted mocks ──────────────────────────────────────────────────
const { mockGetAdminSession, mockSendInvoiceReminder, mockSlidingWindow, mockLogAudit } =
  vi.hoisted(() => ({
    mockGetAdminSession: vi.fn(),
    mockSendInvoiceReminder: vi.fn(),
    mockSlidingWindow: vi.fn(),
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => mockGetAdminSession(),
}));

vi.mock('@/lib/rate-limit', () => ({
  slidingWindow: (...a: unknown[]) => mockSlidingWindow(...a),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

vi.mock('@/lib/communication/money-triggers', () => ({
  sendInvoiceReminder: (...a: unknown[]) => mockSendInvoiceReminder(...a),
}));

vi.mock('@/lib/admin/audit', () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { POST } from '@/app/api/admin/invoices/[id]/send-reminder/route';

const mockSession = {
  userId: 'u1',
  organizationId: 'org-1',
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'admin' as const,
};

function req() {
  return new NextRequest('http://t/api/admin/invoices/i1/send-reminder', { method: 'POST' });
}

const ctx = { params: Promise.resolve({ id: 'i1' }) };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated session + rate limit allowed
  mockGetAdminSession.mockResolvedValue(mockSession);
  mockSlidingWindow.mockReturnValue({ allowed: true });
});

describe('POST /api/admin/invoices/[id]/send-reminder', () => {
  it('returns 401 when not an admin', async () => {
    mockGetAdminSession.mockResolvedValueOnce(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
  });

  it('returns 200 and calls sendInvoiceReminder with org + id on success', async () => {
    mockSendInvoiceReminder.mockResolvedValueOnce({ ok: true });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(mockSendInvoiceReminder).toHaveBeenCalledWith('org-1', 'i1');
    const body = await res.json();
    expect(body.data.ok).toBe(true);
  });

  it('returns 409 on cooldown', async () => {
    mockSendInvoiceReminder.mockResolvedValueOnce({ ok: false, reason: 'cooldown' });
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
  });
});
