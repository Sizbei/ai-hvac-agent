import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAdminSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => getAdminSession(),
}));

const isPlatformAdmin = vi.fn();
vi.mock('@/lib/auth/authz', () => ({
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
}));

const provisionOrganization = vi.fn();
vi.mock('@/lib/admin/provisioning', () => ({
  provisionOrganization: (...a: unknown[]) => provisionOrganization(...a),
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/admin/audit', () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock('@/lib/rate-limit', () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: {
    adminRead: { maxRequests: 60, windowMs: 60_000 },
    adminMutation: { maxRequests: 30, windowMs: 60_000 },
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

// db is only touched by GET; POST goes through the mocked provisionOrganization.
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ orderBy: () => Promise.resolve([]) }) }),
  },
}));
vi.mock('@/lib/db/schema', () => ({
  organizations: {
    id: 'o.id',
    name: 'o.name',
    status: 'o.status',
    createdAt: 'o.createdAt',
  },
}));
vi.mock('drizzle-orm', () => ({ desc: (c: unknown) => c }));

import { NextRequest } from 'next/server';
import { POST, GET } from './route';

const PLATFORM_SESSION = {
  userId: 'platform-admin-uuid',
  organizationId: '00000000-0000-0000-0000-000000000001',
  email: 'platform@x.com',
  name: 'Platform Admin',
  role: 'super_admin' as const,
};

function postReq(body: unknown) {
  return new NextRequest('https://app.example.com/api/platform/organizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getAdminSession.mockReset();
  isPlatformAdmin.mockReset();
  provisionOrganization.mockReset();
  logAudit.mockClear();
});

describe('POST /api/platform/organizations — gate', () => {
  it('401 without a session', async () => {
    getAdminSession.mockResolvedValue(null);
    const res = await POST(postReq({ name: 'Acme', ownerEmail: 'o@acme.com' }));
    expect(res.status).toBe(401);
    expect(provisionOrganization).not.toHaveBeenCalled();
  });

  it('403 for a non-platform-admin (even a super_admin)', async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(false);
    const res = await POST(postReq({ name: 'Acme', ownerEmail: 'o@acme.com' }));
    expect(res.status).toBe(403);
    expect(provisionOrganization).not.toHaveBeenCalled();
  });

  it('proceeds for a platform admin and returns the invite URL', async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(true);
    provisionOrganization.mockResolvedValue({
      ok: true,
      provisioned: {
        organizationId: 'new-org-uuid',
        inviteToken: 'a'.repeat(64),
        ownerInvite: {
          id: 'invite-1',
          email: 'o@acme.com',
          role: 'admin',
          expiresAt: '2026-06-20T00:00:00.000Z',
          createdAt: '2026-06-17T00:00:00.000Z',
        },
      },
    });

    const res = await POST(postReq({ name: 'Acme', ownerEmail: 'o@acme.com' }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.organizationId).toBe('new-org-uuid');
    expect(json.data.inviteUrl).toContain('/admin/invite/' + 'a'.repeat(64));
  });
});

describe('POST /api/platform/organizations — audit has no PII', () => {
  it('never puts ownerEmail/token in audit details', async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(true);
    provisionOrganization.mockResolvedValue({
      ok: true,
      provisioned: {
        organizationId: 'new-org-uuid',
        inviteToken: 'b'.repeat(64),
        ownerInvite: {
          id: 'invite-1',
          email: 'secret-owner@acme.com',
          role: 'admin',
          expiresAt: '2026-06-20T00:00:00.000Z',
          createdAt: '2026-06-17T00:00:00.000Z',
        },
      },
    });

    await POST(
      postReq({ name: 'Acme', ownerEmail: 'secret-owner@acme.com' }),
    );

    expect(logAudit).toHaveBeenCalledTimes(1);
    const auditArg = logAudit.mock.calls[0][0] as { details: string };
    expect(auditArg.details).not.toContain('secret-owner@acme.com');
    expect(auditArg.details).not.toContain('b'.repeat(64));
    // details should be ids/enums only.
    const parsed = JSON.parse(auditArg.details);
    expect(parsed).toEqual({
      createdBy: 'platform-admin-uuid',
      ownerInviteRole: 'admin',
    });
  });
});

describe('POST /api/platform/organizations — provisioning rejections', () => {
  it('maps slug_conflict to 409', async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(true);
    provisionOrganization.mockResolvedValue({
      ok: false,
      reason: 'slug_conflict',
    });
    const res = await POST(postReq({ name: 'Acme', ownerEmail: 'o@acme.com' }));
    expect(res.status).toBe(409);
  });

  it('maps owner_email_in_use to 409', async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(true);
    provisionOrganization.mockResolvedValue({
      ok: false,
      reason: 'owner_email_in_use',
    });
    const res = await POST(postReq({ name: 'Acme', ownerEmail: 'o@acme.com' }));
    expect(res.status).toBe(409);
  });

  it('400 on invalid body', async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(true);
    const res = await POST(postReq({ name: '', ownerEmail: 'not-an-email' }));
    expect(res.status).toBe(400);
    expect(provisionOrganization).not.toHaveBeenCalled();
  });
});

describe('GET /api/platform/organizations — gate', () => {
  it('403 for a non-platform-admin', async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(false);
    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('200 for a platform admin', async () => {
    getAdminSession.mockResolvedValue(PLATFORM_SESSION);
    isPlatformAdmin.mockReturnValue(true);
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(Array.isArray(json.data.organizations)).toBe(true);
  });
});
