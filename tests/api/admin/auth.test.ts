import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// The login route now imports normalizeEmail from staff-queries, which (via the
// consolidated authz policy) transitively imports "server-only". No-op it here
// so this client-context test can load the route module.
vi.mock('server-only', () => ({}));

// --- Hoisted mocks ---

const { mockDbSelect, mockCreateAdminSession, mockDeleteAdminSession, mockBcryptCompare } =
  vi.hoisted(() => {
    const mockDbSelect = vi.fn();
    const mockCreateAdminSession = vi.fn().mockResolvedValue(undefined);
    const mockDeleteAdminSession = vi.fn().mockResolvedValue(undefined);
    const mockBcryptCompare = vi.fn();
    return { mockDbSelect, mockCreateAdminSession, mockDeleteAdminSession, mockBcryptCompare };
  });

// Mock DB with chainable select
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        // The login query is now .where(...).limit(1); mockDbSelect supplies the
        // rows and .limit() just returns them so existing cases are unchanged.
        where: (...args: unknown[]) => ({
          limit: () => mockDbSelect(...args),
        }),
      }),
    }),
  },
}));

vi.mock('@/lib/db/schema', () => ({
  users: { email: 'users.email' },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => args),
}));

vi.mock('@/lib/auth/session', () => ({
  createAdminSession: (...args: unknown[]) => mockCreateAdminSession(...args),
  deleteAdminSession: () => mockDeleteAdminSession(),
}));

vi.mock('bcryptjs', () => ({
  default: {
    compare: (...args: unknown[]) => mockBcryptCompare(...args),
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { POST as loginHandler } from '@/app/api/auth/login/route';
import { POST as logoutHandler } from '@/app/api/auth/logout/route';
import { resetRateLimitStore } from '@/lib/rate-limit';

function createMockRequest(options: {
  method?: string;
  body?: unknown;
  url?: string;
}): NextRequest {
  const url = new URL(options.url ?? 'http://localhost:3000/api/auth/login');
  return new NextRequest(url, {
    method: options.method ?? 'POST',
    ...(options.body
      ? {
          body: JSON.stringify(options.body),
          headers: { 'Content-Type': 'application/json' },
        }
      : {}),
  });
}

const mockAdminUser = {
  id: 'user-001',
  organizationId: 'org-001',
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'admin',
  isActive: true,
  passwordHash: '$2a$12$hashedpassword',
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  // The login route now enforces a real per-IP rate limit; clear the shared
  // in-memory window so attempts don't accumulate across test cases.
  resetRateLimitStore();
});

describe('POST /api/auth/login', () => {
  it('should return 400 for invalid request body', async () => {
    const request = createMockRequest({ body: { email: 'not-an-email' } });
    const response = await loginHandler(request);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should return 401 for non-existent email', async () => {
    mockDbSelect.mockResolvedValue([]);

    const request = createMockRequest({
      body: { email: 'unknown@example.com', password: 'password123' },
    });
    const response = await loginHandler(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  // Non-admin and disabled accounts now return the SAME generic 401 as a
  // wrong password / unknown email. Distinct 403 codes (FORBIDDEN /
  // ACCOUNT_DISABLED) leaked whether an email mapped to a real account and
  // what state it was in — useful intel for an attacker. We refuse to confirm.
  it('should return a generic 401 for a non-admin user (no account-state leak)', async () => {
    mockDbSelect.mockResolvedValue([{ ...mockAdminUser, role: 'technician' }]);
    mockBcryptCompare.mockResolvedValue(true);

    const request = createMockRequest({
      body: { email: 'tech@example.com', password: 'password123' },
    });
    const response = await loginHandler(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('should return a generic 401 for a disabled admin account (no account-state leak)', async () => {
    mockDbSelect.mockResolvedValue([{ ...mockAdminUser, isActive: false }]);
    mockBcryptCompare.mockResolvedValue(true);

    const request = createMockRequest({
      body: { email: 'admin@example.com', password: 'password123' },
    });
    const response = await loginHandler(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('should return 401 for wrong password', async () => {
    mockDbSelect.mockResolvedValue([mockAdminUser]);
    mockBcryptCompare.mockResolvedValue(false);

    const request = createMockRequest({
      body: { email: 'admin@example.com', password: 'wrongpassword' },
    });
    const response = await loginHandler(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('should return 200 and create session for valid admin credentials', async () => {
    mockDbSelect.mockResolvedValue([mockAdminUser]);
    mockBcryptCompare.mockResolvedValue(true);

    const request = createMockRequest({
      body: { email: 'admin@example.com', password: 'correctpassword' },
    });
    const response = await loginHandler(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.user).toEqual({
      id: 'user-001',
      name: 'Admin User',
      email: 'admin@example.com',
    });
    expect(mockCreateAdminSession).toHaveBeenCalledWith({
      userId: 'user-001',
      organizationId: 'org-001',
      email: 'admin@example.com',
      name: 'Admin User',
      role: 'admin',
    });
  });

  it('lowercases a mixed-case email before the DB lookup', async () => {
    // User rows are stored lowercased (normalizeEmail on create), and Postgres
    // text equality is case-sensitive, so the route must lowercase the input
    // before building the lookup condition — otherwise a real user typing
    // mixed-case would miss their own row. (zod .email() already rejects
    // surrounding whitespace, so only case needs normalizing at this layer.)
    mockDbSelect.mockResolvedValue([mockAdminUser]);
    mockBcryptCompare.mockResolvedValue(true);

    const request = createMockRequest({
      body: { email: 'Admin@Example.COM', password: 'correctpassword' },
    });
    const response = await loginHandler(request);

    expect(response.status).toBe(200);
    // eq() mock returns its args as a tuple [col, value]; the value must be the
    // normalized (lowercased) email, proving normalization happened pre-lookup.
    const whereArgs = mockDbSelect.mock.calls[0][0] as unknown[];
    expect(JSON.stringify(whereArgs)).toContain('admin@example.com');
    expect(JSON.stringify(whereArgs)).not.toContain('Admin@Example.COM');
  });
});

describe('POST /api/auth/logout', () => {
  it('should return 200 and delete session on logout', async () => {
    const response = await logoutHandler();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.message).toBe('Logged out');
    expect(mockDeleteAdminSession).toHaveBeenCalled();
  });
});
