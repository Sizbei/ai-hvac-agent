import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Hoisted mocks ---

const { mockGetAdminSession, mockGetDashboardStats } = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockGetDashboardStats: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => mockGetAdminSession(),
}));

vi.mock('@/lib/admin/queries', () => ({
  getDashboardStats: (...args: unknown[]) => mockGetDashboardStats(...args),
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { GET as getStatsHandler } from '@/app/api/admin/stats/route';

const mockSession = {
  userId: 'user-001',
  organizationId: 'org-001',
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'admin' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/admin/stats', () => {
  it('should return 401 when not authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(null);

    const response = await getStatsHandler();
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('should return 4 count values when authenticated', async () => {
    mockGetAdminSession.mockResolvedValue(mockSession);
    const mockStats = {
      pending: 5,
      assignedToday: 3,
      inProgress: 2,
      completedToday: 1,
    };
    mockGetDashboardStats.mockResolvedValue(mockStats);

    const response = await getStatsHandler();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({
      pending: 5,
      assignedToday: 3,
      inProgress: 2,
      completedToday: 1,
    });
    expect(mockGetDashboardStats).toHaveBeenCalledWith('org-001');
  });
});
