import { describe, it, expect, vi, beforeEach } from 'vitest';

// authz.ts imports "server-only", which throws in the vitest runtime. Stub it.
vi.mock('server-only', () => ({}));

const getAdminSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({
  getAdminSession: () => getAdminSession(),
}));

const getAccountingExport = vi.fn();
vi.mock('@/lib/admin/accounting-export', () => ({
  getAccountingExport: (...a: unknown[]) => getAccountingExport(...a),
}));

const format = vi.fn(() => 'Date,Type,Account,Memo,Amount\n');
vi.mock('@/lib/accounting/accounting-provider', () => ({
  getAccountingProvider: () => ({
    name: 'mock',
    fileExtension: 'csv',
    contentType: 'text/csv',
    format,
  }),
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/admin/audit', () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock('@/lib/rate-limit', () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 60, windowMs: 60_000 } },
}));

vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), info: vi.fn() },
}));

import { NextRequest } from 'next/server';
import { GET } from './route';

const SUPER = {
  userId: '11111111-1111-1111-1111-111111111111',
  organizationId: '00000000-0000-0000-0000-000000000001',
  email: 'super@x.com',
  name: 'Super',
  role: 'super_admin' as const,
};
const ADMIN = { ...SUPER, role: 'admin' as const };

function req(query = '') {
  return new NextRequest(
    `https://app.example.com/api/admin/accounting/export${query}`,
  );
}

beforeEach(() => {
  getAdminSession.mockReset();
  getAccountingExport.mockReset();
  logAudit.mockClear();
  format.mockClear();
});

describe('GET /api/admin/accounting/export', () => {
  it('401 when unauthenticated', async () => {
    getAdminSession.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it('403 for a non-super_admin', async () => {
    getAdminSession.mockResolvedValue(ADMIN);
    const res = await GET(req('?from=2026-01-01&to=2026-01-31'));
    expect(res.status).toBe(403);
    // Must not even attempt to build the export for a forbidden caller.
    expect(getAccountingExport).not.toHaveBeenCalled();
  });

  it('400 when from/to are missing', async () => {
    getAdminSession.mockResolvedValue(SUPER);
    expect((await GET(req())).status).toBe(400);
  });

  it('400 when from is after to', async () => {
    getAdminSession.mockResolvedValue(SUPER);
    const res = await GET(req('?from=2026-02-01&to=2026-01-01'));
    expect(res.status).toBe(400);
  });

  it('returns a downloadable CSV + audits (period/count only) for a super_admin', async () => {
    getAdminSession.mockResolvedValue(SUPER);
    getAccountingExport.mockResolvedValue({
      native: [
        { date: '2026-01-05', type: 'invoice', account: 'Sales Revenue', memo: 'Invoice x', amountDollars: 1 },
      ],
      synced: [],
    });

    const res = await GET(req('?from=2026-01-01&to=2026-01-31&format=csv'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('cache-control')).toBe('no-store');

    // Audit carries period + count + provider, never PII/amounts.
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'accounting_exported' }),
    );
    const auditArg = logAudit.mock.calls[0][0] as { details: string };
    const details = JSON.parse(auditArg.details);
    expect(details).toMatchObject({ nativeRowCount: 1, syncedRowCount: 0, provider: 'mock' });
    expect(details.from).toBeTypeOf('string');
    expect(JSON.stringify(details)).not.toContain('amountDollars');
  });

  it('400 for an unsupported format', async () => {
    getAdminSession.mockResolvedValue(SUPER);
    const res = await GET(req('?from=2026-01-01&to=2026-01-31&format=iif'));
    expect(res.status).toBe(400);
  });
});
