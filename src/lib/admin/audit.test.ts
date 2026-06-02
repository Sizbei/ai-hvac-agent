import { describe, it, expect, vi, beforeEach } from 'vitest';

// Use vi.hoisted to create mocks that are available when vi.mock factories run
const { mockValues, mockInsert } = vi.hoisted(() => {
  const mockValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
  return { mockValues, mockInsert };
});

vi.mock('@/lib/db', () => ({
  db: {
    insert: mockInsert,
  },
}));

// Mock the schema to provide a recognizable table reference
vi.mock('@/lib/db/schema', () => ({
  auditLog: Symbol('auditLog'),
}));

import { logAudit } from '@/lib/admin/audit';
import { auditLog } from '@/lib/db/schema';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('logAudit', () => {
  it('should insert into auditLog with all fields provided', async () => {
    await logAudit({
      organizationId: 'org-123',
      userId: 'user-456',
      action: 'assign_technician',
      entity: 'service_request',
      entityId: 'req-789',
      details: '{"technicianId":"tech-001"}',
    });

    expect(mockInsert).toHaveBeenCalledWith(auditLog);
    expect(mockValues).toHaveBeenCalledWith({
      organizationId: 'org-123',
      userId: 'user-456',
      action: 'assign_technician',
      entity: 'service_request',
      entityId: 'req-789',
      details: '{"technicianId":"tech-001"}',
      ipAddress: null,
    });
  });

  it('should default entityId and details to null when not provided', async () => {
    await logAudit({
      organizationId: 'org-123',
      userId: 'user-456',
      action: 'create_technician',
      entity: 'user',
    });

    expect(mockInsert).toHaveBeenCalledWith(auditLog);
    expect(mockValues).toHaveBeenCalledWith({
      organizationId: 'org-123',
      userId: 'user-456',
      action: 'create_technician',
      entity: 'user',
      entityId: null,
      details: null,
      ipAddress: null,
    });
  });

  it('should handle entityId present but details absent', async () => {
    await logAudit({
      organizationId: 'org-123',
      userId: 'user-456',
      action: 'update_technician',
      entity: 'user',
      entityId: 'tech-002',
    });

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'tech-002',
        details: null,
      }),
    );
  });

  it('records ipAddress when provided', async () => {
    await logAudit({
      organizationId: 'org-123',
      userId: 'user-456',
      action: 'customer_updated',
      entity: 'customers',
      entityId: 'cust-1',
      ipAddress: '203.0.113.7',
    });

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '203.0.113.7' }),
    );
  });
});
