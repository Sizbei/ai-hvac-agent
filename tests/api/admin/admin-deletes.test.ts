import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// ─── Hoisted mocks ─────────────────────────────────────────────────
const {
  mockGetAdminSession,
  mockDeleteConversation,
  mockGetConversationById,
  mockDeleteCustomer,
  mockGetCustomerById,
  mockSlidingWindow,
} = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockDeleteConversation: vi.fn(),
  mockGetConversationById: vi.fn(),
  mockDeleteCustomer: vi.fn(),
  mockGetCustomerById: vi.fn(),
  mockSlidingWindow: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => mockGetAdminSession(),
}));

vi.mock('@/lib/admin/conversation-queries', () => ({
  getConversationById: (...a: unknown[]) => mockGetConversationById(...a),
  deleteConversation: (...a: unknown[]) => mockDeleteConversation(...a),
}));

vi.mock('@/lib/admin/crm-queries', () => ({
  getCustomerById: (...a: unknown[]) => mockGetCustomerById(...a),
  addEquipment: vi.fn(),
  addNote: vi.fn(),
  addFollowUp: vi.fn(),
  deleteCustomer: (...a: unknown[]) => mockDeleteCustomer(...a),
}));

vi.mock('@/lib/rate-limit', () => ({
  slidingWindow: (...a: unknown[]) => mockSlidingWindow(...a),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { DELETE as deleteConversationHandler } from '@/app/api/admin/conversations/[id]/route';
import { DELETE as deleteCustomerHandler } from '@/app/api/admin/customers/[id]/route';

const SESSION = {
  userId: 'admin-1',
  organizationId: 'org-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'admin' as const,
};
const VALID_ID = '11111111-1111-4111-8111-111111111111';

function req(id: string): NextRequest {
  return new NextRequest(
    new URL(`http://localhost:3000/api/admin/x/${id}`),
    { method: 'DELETE' },
  );
}
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAdminSession.mockResolvedValue(SESSION);
  mockSlidingWindow.mockReturnValue({ allowed: true, remaining: 29, resetMs: 60_000 });
});

// Run the same contract against both delete endpoints.
const endpoints = [
  {
    name: 'conversations',
    handler: deleteConversationHandler,
    fn: mockDeleteConversation,
  },
  {
    name: 'customers',
    handler: deleteCustomerHandler,
    fn: mockDeleteCustomer,
  },
] as const;

for (const { name, handler, fn } of endpoints) {
  describe(`DELETE /api/admin/${name}/[id]`, () => {
    it('returns 401 when not authenticated', async () => {
      mockGetAdminSession.mockResolvedValue(null);
      const res = await handler(req(VALID_ID), params(VALID_ID));
      expect(res.status).toBe(401);
      expect(fn).not.toHaveBeenCalled();
    });

    it('returns 429 when rate limited', async () => {
      mockSlidingWindow.mockReturnValue({ allowed: false, remaining: 0, resetMs: 1000 });
      const res = await handler(req(VALID_ID), params(VALID_ID));
      expect(res.status).toBe(429);
      expect(fn).not.toHaveBeenCalled();
    });

    it('returns 400 for a malformed id', async () => {
      const res = await handler(req('not-a-uuid'), params('not-a-uuid'));
      expect(res.status).toBe(400);
      expect(fn).not.toHaveBeenCalled();
    });

    it('returns 404 when the record does not exist', async () => {
      fn.mockResolvedValue(false);
      const res = await handler(req(VALID_ID), params(VALID_ID));
      expect(res.status).toBe(404);
    });

    it('returns 200 and forwards the acting admin for the audit trail', async () => {
      fn.mockResolvedValue(true);
      const res = await handler(req(VALID_ID), params(VALID_ID));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(fn).toHaveBeenCalledWith(
        SESSION.organizationId,
        VALID_ID,
        expect.objectContaining({ userId: SESSION.userId }),
      );
    });
  });
}
