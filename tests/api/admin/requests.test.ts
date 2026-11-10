import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- Hoisted mocks ---

const { mockGetAdminSession, mockGetRequests, mockGetRequestById, mockAssignTechnician, mockLogAudit } =
  vi.hoisted(() => ({
    mockGetAdminSession: vi.fn(),
    mockGetRequests: vi.fn(),
    mockGetRequestById: vi.fn(),
    mockAssignTechnician: vi.fn(),
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
  }));

vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => mockGetAdminSession(),
}));

// The route reads the viewer; derive it from the session mock (an org user).
vi.mock('@/lib/auth/viewer', () => ({
  getViewerContext: async () => {
    const session = await mockGetAdminSession();
    return session ? { session, showHidden: false } : null;
  },
}));

vi.mock('@/lib/admin/queries', () => ({
  getRequests: (...args: unknown[]) => mockGetRequests(...args),
  getRequestById: (...args: unknown[]) => mockGetRequestById(...args),
  assignTechnician: (...args: unknown[]) => mockAssignTechnician(...args),
}));

// The create path lazy-loads its DB writer; it must never be reached by the
// validation tests below.
const { mockCreateAdminRequest } = vi.hoisted(() => ({ mockCreateAdminRequest: vi.fn() }));
vi.mock('@/lib/admin/create-request-queries', () => ({
  createAdminRequest: (...args: unknown[]) => mockCreateAdminRequest(...args),
}));

vi.mock('@/lib/admin/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { GET as getRequestsHandler, POST as createRequestHandler } from '@/app/api/admin/requests/route';
import { businessIsoDate } from '@/lib/admin/calendar-time';
import { GET as getRequestByIdHandler } from '@/app/api/admin/requests/[id]/route';
import { POST as assignHandler } from '@/app/api/admin/requests/[id]/assign/route';

const mockSession = {
  userId: 'user-001',
  organizationId: 'org-001',
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'admin' as const,
};

function createMockRequest(options: {
  method?: string;
  body?: unknown;
  url?: string;
}): NextRequest {
  const url = new URL(options.url ?? 'http://localhost:3000/api/admin/requests');
  return new NextRequest(url, {
    method: options.method ?? 'GET',
    ...(options.body
      ? {
          body: JSON.stringify(options.body),
          headers: { 'Content-Type': 'application/json' },
        }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/requests', () => {
  it('should return 401 when not authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const request = createMockRequest({});
    const response = await getRequestsHandler(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('should return request list with pagination when authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockGetRequests.mockResolvedValue({ requests: [], total: 0 });

    const request = createMockRequest({
      url: 'http://localhost:3000/api/admin/requests?page=1&limit=10',
    });
    const response = await getRequestsHandler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty('requests');
    expect(body.data).toHaveProperty('total');
    expect(body.data).toHaveProperty('page');
    expect(body.data).toHaveProperty('limit');
    expect(mockGetRequests).toHaveBeenCalledWith(
      'org-001',
      { status: undefined, page: 1, limit: 10 },
      expect.objectContaining({ showHidden: false }),
    );
  });

  it('should pass status filter to query function', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockGetRequests.mockResolvedValue({ requests: [], total: 0 });

    const request = createMockRequest({
      url: 'http://localhost:3000/api/admin/requests?status=pending',
    });
    await getRequestsHandler(request);

    expect(mockGetRequests).toHaveBeenCalledWith(
      'org-001',
      expect.objectContaining({ status: 'pending' }),
      expect.objectContaining({ showHidden: false }),
    );
  });
});

describe('GET /api/admin/requests/[id]', () => {
  it('should return 401 when not authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const request = createMockRequest({
      url: 'http://localhost:3000/api/admin/requests/550e8400-e29b-41d4-a716-446655440000',
    });
    const response = await getRequestByIdHandler(request, {
      params: Promise.resolve({ id: '550e8400-e29b-41d4-a716-446655440000' }),
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
  });

  it('should return 400 for invalid UUID format', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);

    const request = createMockRequest({
      url: 'http://localhost:3000/api/admin/requests/not-a-uuid',
    });
    const response = await getRequestByIdHandler(request, {
      params: Promise.resolve({ id: 'not-a-uuid' }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('should return 404 when request not found', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockGetRequestById.mockResolvedValue(null);

    const validId = '550e8400-e29b-41d4-a716-446655440000';
    const request = createMockRequest({
      url: `http://localhost:3000/api/admin/requests/${validId}`,
    });
    const response = await getRequestByIdHandler(request, {
      params: Promise.resolve({ id: validId }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});

describe('POST /api/admin/requests/[id]/assign', () => {
  const requestId = '550e8400-e29b-41d4-a716-446655440000';
  const technicianId = '660e8400-e29b-41d4-a716-446655440000';

  it('should return 401 when not authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      url: `http://localhost:3000/api/admin/requests/${requestId}/assign`,
      body: { technicianId },
    });
    const response = await assignHandler(request, {
      params: Promise.resolve({ id: requestId }),
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
  });

  it('should return updated request and log audit on successful assignment', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    const mockUpdated = {
      id: requestId,
      status: 'assigned',
      issueType: 'heating',
      urgency: 'medium',
      description: 'Heater broken',
      referenceNumber: 'REF-001',
      customerName: 'John',
      assignedToName: 'Tech A',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    mockAssignTechnician.mockResolvedValue({ ok: true, request: mockUpdated });

    const request = createMockRequest({
      method: 'POST',
      url: `http://localhost:3000/api/admin/requests/${requestId}/assign`,
      body: { technicianId },
    });
    const response = await assignHandler(request, {
      params: Promise.resolve({ id: requestId }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('assigned');

    // Verify audit log was called (T-03-19 non-repudiation)
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-001',
        userId: 'user-001',
        action: 'assign_technician',
        entity: 'service_request',
        entityId: requestId,
      }),
    );
  });

  it('should return 404 when the technician is not a valid active technician', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockAssignTechnician.mockResolvedValue({
      ok: false,
      reason: 'technician_not_found',
    });

    const request = createMockRequest({
      method: 'POST',
      url: `http://localhost:3000/api/admin/requests/${requestId}/assign`,
      body: { technicianId },
    });
    const response = await assignHandler(request, {
      params: Promise.resolve({ id: requestId }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('TECHNICIAN_NOT_FOUND');
  });

  it('should return 404 when the request does not exist', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockAssignTechnician.mockResolvedValue({
      ok: false,
      reason: 'request_not_found',
    });

    const request = createMockRequest({
      method: 'POST',
      url: `http://localhost:3000/api/admin/requests/${requestId}/assign`,
      body: { technicianId },
    });
    const response = await assignHandler(request, {
      params: Promise.resolve({ id: requestId }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('should return 409 when the request is not in an assignable state', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockAssignTechnician.mockResolvedValue({
      ok: false,
      reason: 'request_not_assignable',
      currentStatus: 'in_progress',
    });

    const request = createMockRequest({
      method: 'POST',
      url: `http://localhost:3000/api/admin/requests/${requestId}/assign`,
      body: { technicianId },
    });
    const response = await assignHandler(request, {
      params: Promise.resolve({ id: requestId }),
    });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error.code).toBe('REQUEST_NOT_ASSIGNABLE');
    // Audit must NOT be written for a rejected assignment.
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('should return 400 for invalid technicianId format', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);

    const request = createMockRequest({
      method: 'POST',
      url: `http://localhost:3000/api/admin/requests/${requestId}/assign`,
      body: { technicianId: 'not-a-uuid' },
    });
    const response = await assignHandler(request, {
      params: Promise.resolve({ id: requestId }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('POST /api/admin/requests — past windows (round-2 P1-2)', () => {
  it('refuses a window that has already ended, before any write', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    // Yesterday is inside the allowed day range, but every band on it is over.
    const yesterday = businessIsoDate(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const response = await createRequestHandler(
      createMockRequest({
        method: 'POST',
        body: {
          customerId: '11111111-1111-4111-8111-111111111111',
          address: '12 Main St, Johnson City, TN 37601',
          issueType: 'cooling_not_working',
          urgency: 'high',
          description: 'AC blowing warm air',
          schedule: { isoDay: yesterday, window: 'evening' },
        },
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body.error).toEqual({
      code: 'VALIDATION_ERROR',
      message: 'That arrival window has already ended. Pick a later one.',
    });
    expect(mockCreateAdminRequest).not.toHaveBeenCalled();
  });
});
