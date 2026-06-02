import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// --- Hoisted mocks ---

const {
  mockGetAdminSession,
  mockGetTechnicians,
  mockCreateTechnician,
  mockUpdateTechnician,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockGetTechnicians: vi.fn(),
  mockCreateTechnician: vi.fn(),
  mockUpdateTechnician: vi.fn(),
  mockLogAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => mockGetAdminSession(),
}));

vi.mock('@/lib/admin/queries', () => ({
  getTechnicians: (...args: unknown[]) => mockGetTechnicians(...args),
  createTechnician: (...args: unknown[]) => mockCreateTechnician(...args),
  updateTechnician: (...args: unknown[]) => mockUpdateTechnician(...args),
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

import { GET as listTechniciansHandler, POST as createTechnicianHandler } from '@/app/api/admin/technicians/route';
import { PATCH as updateTechnicianHandler } from '@/app/api/admin/technicians/[id]/route';

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
  const url = new URL(options.url ?? 'http://localhost:3000/api/admin/technicians');
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

describe('GET /api/admin/technicians', () => {
  it('should return 401 when not authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const response = await listTechniciansHandler();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('should return technician list when authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    const mockTechs = [
      { id: 't1', name: 'Tech A', email: 'a@x.com', isActive: true, createdAt: '2026-01-01T00:00:00Z' },
      { id: 't2', name: 'Tech B', email: 'b@x.com', isActive: false, createdAt: '2026-01-02T00:00:00Z' },
    ];
    mockGetTechnicians.mockResolvedValue(mockTechs);

    const response = await listTechniciansHandler();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.technicians).toHaveLength(2);
    expect(mockGetTechnicians).toHaveBeenCalledWith('org-001');
  });
});

describe('POST /api/admin/technicians', () => {
  it('should return 401 when not authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'New Tech', email: 'new@example.com', password: 'password123' },
    });
    const response = await createTechnicianHandler(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
  });

  it('should create technician and return 201', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    const mockCreated = {
      id: 'new-tech-001',
      name: 'New Tech',
      email: 'new@example.com',
      isActive: true,
      createdAt: '2026-01-01T00:00:00Z',
    };
    mockCreateTechnician.mockResolvedValue(mockCreated);

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'New Tech', email: 'new@example.com', password: 'password123' },
    });
    const response = await createTechnicianHandler(request);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.data.id).toBe('new-tech-001');
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create_technician',
        entity: 'user',
        entityId: 'new-tech-001',
      }),
    );
  });

  it('should return 400 for invalid body (short password)', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);

    const request = createMockRequest({
      method: 'POST',
      body: { name: 'New Tech', email: 'new@example.com', password: 'short' },
    });
    const response = await createTechnicianHandler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('PATCH /api/admin/technicians/[id]', () => {
  const techId = '550e8400-e29b-41d4-a716-446655440000';

  it('should return 401 when not authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      url: `http://localhost:3000/api/admin/technicians/${techId}`,
      body: { name: 'Updated Name' },
    });
    const response = await updateTechnicianHandler(request, {
      params: Promise.resolve({ id: techId }),
    });
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
  });

  it('should update technician and log audit', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    const mockUpdated = {
      id: techId,
      name: 'Updated Name',
      email: 'tech@example.com',
      isActive: true,
      createdAt: '2026-01-01T00:00:00Z',
    };
    mockUpdateTechnician.mockResolvedValue(mockUpdated);

    const request = createMockRequest({
      method: 'PATCH',
      url: `http://localhost:3000/api/admin/technicians/${techId}`,
      body: { name: 'Updated Name' },
    });
    const response = await updateTechnicianHandler(request, {
      params: Promise.resolve({ id: techId }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe('Updated Name');
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update_technician',
        entity: 'user',
        entityId: techId,
      }),
    );
    // The audit `details` must record only WHICH fields changed, never the
    // values — name/email are PII surfaced verbatim by the audit-log viewer.
    const auditCall = mockLogAudit.mock.calls[0][0] as { details?: string };
    const detailsObj = JSON.parse(auditCall.details ?? '{}') as {
      fields?: string[];
    };
    expect(detailsObj).toHaveProperty('fields');
    expect(detailsObj.fields).toContain('name');
    expect(JSON.stringify(detailsObj)).not.toContain('Updated Name');
  });

  it('should return 404 when technician not found', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    mockUpdateTechnician.mockResolvedValue(null);

    const request = createMockRequest({
      method: 'PATCH',
      url: `http://localhost:3000/api/admin/technicians/${techId}`,
      body: { name: 'Updated Name' },
    });
    const response = await updateTechnicianHandler(request, {
      params: Promise.resolve({ id: techId }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
