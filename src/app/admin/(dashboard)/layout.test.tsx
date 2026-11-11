import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
// React.cache only exists under the react-server condition.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <F,>(fn: F) => fn,
}));

const getAdminSession = vi.fn();
vi.mock('@/lib/auth/session', () => ({ getAdminSession: () => getAdminSession() }));

const getViewerContext = vi.fn();
vi.mock('@/lib/auth/viewer', () => ({ getViewerContext: () => getViewerContext() }));

const loadOrgRow = vi.fn();
vi.mock('@/lib/tenancy/org-row', () => ({ loadOrgRowCached: (id: string) => loadOrgRow(id) }));

const setupSelect = vi.fn();
vi.mock('@/lib/db', () => {
  const chain: Record<string, unknown> = {};
  for (const k of ['from', 'leftJoin', 'where']) chain[k] = () => chain;
  chain.limit = () => Promise.resolve([{ onboardingState: null }]);
  return {
    db: {
      select: (...a: unknown[]) => {
        setupSelect(...a);
        return chain;
      },
    },
  };
});

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock('@/components/admin/dashboard-shell', () => ({ DashboardShell: () => null }));

import DashboardLayout from './layout';

const ORG = '11111111-1111-4111-8111-111111111111';
const SESSION = { userId: 'u-1', organizationId: ORG, email: 'a@x.io', name: 'Ann', role: 'admin' };
const VIEWER = {
  session: SESSION,
  isPlatformAdmin: false,
  features: {},
  preview: null,
  uiRole: 'admin',
  showHidden: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
  loadOrgRow.mockResolvedValue({ status: 'active', name: 'Acme', featureFlags: {} });
});

describe('DashboardLayout reads (final wave M1)', () => {
  it('starts the org row and setup reads before the viewer resolves', async () => {
    let resolveViewer: (v: unknown) => void = () => {};
    getViewerContext.mockReturnValue(new Promise((r) => (resolveViewer = r)));

    const rendering = DashboardLayout({ children: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(loadOrgRow).toHaveBeenCalledWith(ORG);
    expect(setupSelect).toHaveBeenCalled();

    resolveViewer(VIEWER);
    await expect(rendering).resolves.toBeTruthy();
  });

  it('redirects to sign in without a session and reads nothing', async () => {
    getAdminSession.mockResolvedValue(null);
    getViewerContext.mockResolvedValue(null);
    await expect(DashboardLayout({ children: null })).rejects.toThrow('redirect:/admin/login');
    expect(loadOrgRow).not.toHaveBeenCalled();
    expect(setupSelect).not.toHaveBeenCalled();
  });

  it('redirects when the viewer is gone even with a session', async () => {
    getViewerContext.mockResolvedValue(null);
    await expect(DashboardLayout({ children: null })).rejects.toThrow('redirect:/admin/login');
  });
});
