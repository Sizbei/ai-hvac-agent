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
  mockUpdateEquipment,
  mockDeleteEquipment,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockDeleteConversation: vi.fn(),
  mockGetConversationById: vi.fn(),
  mockDeleteCustomer: vi.fn(),
  mockGetCustomerById: vi.fn(),
  mockSlidingWindow: vi.fn(),
  mockUpdateEquipment: vi.fn(),
  mockDeleteEquipment: vi.fn(),
  mockLogAudit: vi.fn(),
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
  updateCustomerContact: vi.fn(),
  completeFollowUp: vi.fn(),
  deleteCustomer: (...a: unknown[]) => mockDeleteCustomer(...a),
}));

vi.mock('@/lib/admin/crm-equipment-queries', () => ({
  updateEquipment: (...a: unknown[]) => mockUpdateEquipment(...a),
  deleteEquipment: (...a: unknown[]) => mockDeleteEquipment(...a),
  // Real enum guard so route-level type validation is exercised, not mocked.
  isEquipmentType: (v: string) =>
    ['ac', 'furnace', 'heat_pump', 'boiler', 'mini_split', 'thermostat', 'other'].includes(v),
}));

vi.mock('@/lib/admin/audit', () => ({
  logAudit: (...a: unknown[]) => mockLogAudit(...a),
}));

vi.mock('@/lib/rate-limit', () => ({
  slidingWindow: (...a: unknown[]) => mockSlidingWindow(...a),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60_000 } },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

import { DELETE as deleteConversationHandler } from '@/app/api/admin/conversations/[id]/route';
import {
  DELETE as deleteCustomerHandler,
  POST as customerPostHandler,
} from '@/app/api/admin/customers/[id]/route';

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
  // The customer POST route now gates on org ownership (getCustomerById) before
  // any action; default to an existing customer so the action tests reach it.
  mockGetCustomerById.mockResolvedValue({ id: CUSTOMER_ID });
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

// ─── POST equipment actions on the customer route ──────────────────
const CUSTOMER_ID = '22222222-2222-4222-8222-222222222222';
const EQUIPMENT_ID = '33333333-3333-4333-8333-333333333333';

function postReq(body: unknown): NextRequest {
  return new NextRequest(
    new URL(`http://localhost:3000/api/admin/customers/${CUSTOMER_ID}`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

describe('POST /api/admin/customers/[id] — update_equipment', () => {
  it('returns 400 for a malformed equipmentId', async () => {
    const res = await customerPostHandler(
      postReq({ action: 'update_equipment', equipmentId: 'nope', make: 'X' }),
      params(CUSTOMER_ID),
    );
    expect(res.status).toBe(400);
    expect(mockUpdateEquipment).not.toHaveBeenCalled();
  });

  it('returns 400 invalid type when the query rejects the enum', async () => {
    mockUpdateEquipment.mockResolvedValue({ ok: false, reason: 'invalid_type' });
    const res = await customerPostHandler(
      postReq({
        action: 'update_equipment',
        equipmentId: EQUIPMENT_ID,
        equipmentType: 'spaceship',
      }),
      params(CUSTOMER_ID),
    );
    expect(res.status).toBe(400);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('returns 404 when the equipment is not found', async () => {
    mockUpdateEquipment.mockResolvedValue({ ok: false, reason: 'not_found' });
    const res = await customerPostHandler(
      postReq({ action: 'update_equipment', equipmentId: EQUIPMENT_ID, make: 'X' }),
      params(CUSTOMER_ID),
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 and audits the written fields on success', async () => {
    mockUpdateEquipment.mockResolvedValue({
      ok: true,
      updatedFields: ['make', 'equipmentType'],
    });
    const res = await customerPostHandler(
      postReq({
        action: 'update_equipment',
        equipmentId: EQUIPMENT_ID,
        make: 'Trane',
        equipmentType: 'furnace',
      }),
      params(CUSTOMER_ID),
    );
    expect(res.status).toBe(200);
    expect(mockUpdateEquipment).toHaveBeenCalledWith(
      SESSION.organizationId,
      CUSTOMER_ID,
      EQUIPMENT_ID,
      expect.objectContaining({ make: 'Trane', equipmentType: 'furnace' }),
    );
    // Audit records the fields the QUERY reports as written, not request keys.
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update_equipment',
        entity: 'customer_equipment',
        entityId: EQUIPMENT_ID,
        details: JSON.stringify({ fields: ['make', 'equipmentType'] }),
      }),
    );
  });
});

describe('POST /api/admin/customers/[id] — delete_equipment', () => {
  it('returns 400 for a malformed equipmentId', async () => {
    const res = await customerPostHandler(
      postReq({ action: 'delete_equipment', equipmentId: 'nope' }),
      params(CUSTOMER_ID),
    );
    expect(res.status).toBe(400);
    expect(mockDeleteEquipment).not.toHaveBeenCalled();
  });

  it('returns 404 when the equipment is not found', async () => {
    mockDeleteEquipment.mockResolvedValue(false);
    const res = await customerPostHandler(
      postReq({ action: 'delete_equipment', equipmentId: EQUIPMENT_ID }),
      params(CUSTOMER_ID),
    );
    expect(res.status).toBe(404);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('returns 200 and writes an audit entry on success', async () => {
    mockDeleteEquipment.mockResolvedValue(true);
    const res = await customerPostHandler(
      postReq({ action: 'delete_equipment', equipmentId: EQUIPMENT_ID }),
      params(CUSTOMER_ID),
    );
    expect(res.status).toBe(200);
    expect(mockDeleteEquipment).toHaveBeenCalledWith(
      SESSION.organizationId,
      CUSTOMER_ID,
      EQUIPMENT_ID,
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'delete_equipment',
        entityId: EQUIPMENT_ID,
      }),
    );
  });
});
