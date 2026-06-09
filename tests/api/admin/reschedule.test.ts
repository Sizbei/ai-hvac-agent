import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- Hoisted mocks (mirrors requests.test.ts) ---

const { mockGetAdminSession, mockPlaceAndAssign, mockLogAudit } = vi.hoisted(
  () => ({
    mockGetAdminSession: vi.fn(),
    mockPlaceAndAssign: vi.fn(),
    mockLogAudit: vi.fn().mockResolvedValue(undefined),
  }),
);

vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => mockGetAdminSession(),
}));

vi.mock('@/lib/admin/scheduling-queries', () => ({
  placeAndAssignRequest: (...args: unknown[]) => mockPlaceAndAssign(...args),
}));

vi.mock('@/lib/admin/audit', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

// calendar-time + arrival-window run REAL — they're pure timezone math, and we
// want to assert the route persists the Eastern window the dispatcher dropped on.
import { POST as rescheduleHandler } from '@/app/api/admin/requests/[id]/reschedule/route';

const mockSession = {
  userId: 'user-001',
  organizationId: 'org-001',
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'admin' as const,
};

const requestId = '550e8400-e29b-41d4-a716-446655440000';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(
    new URL(`http://localhost:3000/api/admin/requests/${requestId}/reschedule`),
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/admin/requests/[id]/reschedule', () => {
  it('returns 401 when not authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await rescheduleHandler(
      createRequest({ date: '2026-07-01', arrivalWindow: 'morning' }),
      params(requestId),
    );
    const body = await res.json();
    expect(res.status).toBe(401);
    expect(body.error.code).toBe('UNAUTHORIZED');
    expect(mockPlaceAndAssign).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid request ID format', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    const res = await rescheduleHandler(
      createRequest({ date: '2026-07-01', arrivalWindow: 'morning' }),
      params('not-a-uuid'),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('returns 400 for a malformed date', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    const res = await rescheduleHandler(
      createRequest({ date: '07/01/2026', arrivalWindow: 'morning' }),
      params(requestId),
    );
    expect(res.status).toBe(400);
    expect(mockPlaceAndAssign).not.toHaveBeenCalled();
  });

  it('returns 400 for an impossible calendar date', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    const res = await rescheduleHandler(
      createRequest({ date: '2026-02-31', arrivalWindow: 'morning' }),
      params(requestId),
    );
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for an unknown arrival window', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    const res = await rescheduleHandler(
      createRequest({ date: '2026-07-01', arrivalWindow: 'midnight' }),
      params(requestId),
    );
    expect(res.status).toBe(400);
    expect(mockPlaceAndAssign).not.toHaveBeenCalled();
  });

  it('reschedules, resolves the Eastern window to UTC, and writes an audit row', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockPlaceAndAssign.mockResolvedValue({
      ok: true,
      status: 'scheduled',
      scheduledDate: '2026-07-01T12:00:00.000Z',
      arrivalWindowStart: '2026-07-01T12:00:00.000Z',
      arrivalWindowEnd: '2026-07-01T16:00:00.000Z',
      assignedTo: null,
      overriddenConflicts: null,
    });

    const res = await rescheduleHandler(
      createRequest({ date: '2026-07-01', arrivalWindow: 'morning' }),
      params(requestId),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);

    // The route must hand placeAndAssignRequest a window in EASTERN wall-clock: 8 AM
    // morning on a summer day is 12:00Z (EDT, UTC-4), NOT 08:00Z. The 4th arg
    // carries the isoDay + window for the availability check (no technicianId on
    // a pure reschedule).
    const [orgId, id, window, options] = mockPlaceAndAssign.mock.calls[0];
    expect(orgId).toBe('org-001');
    expect(id).toBe(requestId);
    expect((window.start as Date).toISOString()).toBe('2026-07-01T12:00:00.000Z');
    expect((window.end as Date).toISOString()).toBe('2026-07-01T16:00:00.000Z');
    expect(options).toMatchObject({ isoDay: '2026-07-01', window: 'morning' });
    expect(options.technicianId).toBeUndefined();

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'request_rescheduled',
        entity: 'service_request',
        entityId: requestId,
      }),
    );
  });

  it('drag-to-assign: forwards technicianId and logs a reassignment audit action', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    const techId = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
    mockPlaceAndAssign.mockResolvedValue({
      ok: true,
      status: 'assigned',
      scheduledDate: '2026-07-01T12:00:00.000Z',
      arrivalWindowStart: '2026-07-01T12:00:00.000Z',
      arrivalWindowEnd: '2026-07-01T16:00:00.000Z',
      assignedTo: techId,
      overriddenConflicts: null,
    });

    const res = await rescheduleHandler(
      createRequest({
        date: '2026-07-01',
        arrivalWindow: 'morning',
        technicianId: techId,
      }),
      params(requestId),
    );
    expect(res.status).toBe(200);
    const options = mockPlaceAndAssign.mock.calls[0][3];
    expect(options.technicianId).toBe(techId);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'request_reassigned_scheduled' }),
    );
  });

  it('returns 409 SCHEDULE_CONFLICT with the conflict detail and skips the audit', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockPlaceAndAssign.mockResolvedValue({
      ok: false,
      reason: 'conflict',
      detail: {
        conflicts: [
          {
            id: 'other',
            referenceNumber: 'REF-2',
            arrivalWindowStart: '2026-07-01T12:00:00.000Z',
            arrivalWindowEnd: '2026-07-01T16:00:00.000Z',
            status: 'assigned',
            assignedTo: 'tech-x',
          },
        ],
        outsideAvailability: false,
      },
    });

    const res = await rescheduleHandler(
      createRequest({ date: '2026-07-01', arrivalWindow: 'morning' }),
      params(requestId),
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('SCHEDULE_CONFLICT');
    // The 409 carries the conflict detail so the client can show the warning.
    expect(body.error.details.conflicts).toHaveLength(1);
    expect(body.error.details.conflicts[0].id).toBe('other');
    // Nothing was written → no audit row.
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('returns a 409 message naming the out-of-hours violation', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockPlaceAndAssign.mockResolvedValue({
      ok: false,
      reason: 'conflict',
      detail: { conflicts: [], outsideAvailability: true },
    });

    const res = await rescheduleHandler(
      createRequest({ date: '2026-07-01', arrivalWindow: 'evening' }),
      params(requestId),
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('SCHEDULE_CONFLICT');
    expect(body.error.message).toMatch(/working hours/i);
  });

  it('override:true commits past the gate and audits the override', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockPlaceAndAssign.mockResolvedValue({
      ok: true,
      status: 'assigned',
      scheduledDate: '2026-07-01T12:00:00.000Z',
      arrivalWindowStart: '2026-07-01T12:00:00.000Z',
      arrivalWindowEnd: '2026-07-01T16:00:00.000Z',
      assignedTo: 'tech-x',
      overriddenConflicts: { conflicts: [], outsideAvailability: true },
    });

    const res = await rescheduleHandler(
      createRequest({
        date: '2026-07-01',
        arrivalWindow: 'morning',
        override: true,
      }),
      params(requestId),
    );
    expect(res.status).toBe(200);
    expect(mockPlaceAndAssign.mock.calls[0][3].override).toBe(true);
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.stringContaining('"override":true'),
      }),
    );
  });

  it('returns 404 TECHNICIAN_NOT_FOUND when the target tech is invalid', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockPlaceAndAssign.mockResolvedValue({
      ok: false,
      reason: 'technician_not_found',
    });

    const res = await rescheduleHandler(
      createRequest({
        date: '2026-07-01',
        arrivalWindow: 'morning',
        technicianId: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
      }),
      params(requestId),
    );
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('TECHNICIAN_NOT_FOUND');
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('returns 409 and skips the audit when the request is terminal', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockPlaceAndAssign.mockResolvedValue({
      ok: false,
      reason: 'request_terminal',
      currentStatus: 'completed',
    });

    const res = await rescheduleHandler(
      createRequest({ date: '2026-07-01', arrivalWindow: 'afternoon' }),
      params(requestId),
    );
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe('REQUEST_TERMINAL');
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it('returns 404 when the request is not found', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockPlaceAndAssign.mockResolvedValue({
      ok: false,
      reason: 'request_not_found',
    });

    const res = await rescheduleHandler(
      createRequest({ date: '2026-07-01', arrivalWindow: 'evening' }),
      params(requestId),
    );
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
