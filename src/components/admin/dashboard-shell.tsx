'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Sidebar } from '@/components/admin/sidebar';
import { AdminHeader } from '@/components/admin/admin-header';
import { GlobalSearch } from '@/components/admin/global-search';
import { navLabelFor, type SetupPlacement } from '@/components/admin/nav-items';
import { SetupPlacementProvider } from '@/components/admin/setup-placement-context';
import type { AdminRole } from '@/lib/auth/types';

interface DashboardShellProps {
  readonly orgName?: string;
  readonly adminName: string;
  readonly adminEmail: string;
  readonly role: AdminRole;
  /** When true, the org's subscription is past_due/suspended — render the
   * non-dismissable billing banner above the content. */
  readonly billingAttention?: boolean;
  /** Server-decided position of the Setup nav item for this page load. */
  readonly setupPlacement: SetupPlacement;
  readonly children: React.ReactNode;
}

/** The current page's nav label for the mobile top bar (undefined if none). */
function useMobileTitle(placement: SetupPlacement): string | undefined {
  return navLabelFor(usePathname(), placement);
}

export function DashboardShell({
  orgName,
  adminName,
  adminEmail,
  role,
  billingAttention = false,
  setupPlacement,
  children,
}: DashboardShellProps) {
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const mobileTitle = useMobileTitle(setupPlacement);

  const handleMobileClose = useCallback(() => {
    setIsMobileOpen(false);
  }, []);

  const handleMenuClick = useCallback(() => {
    setIsMobileOpen((prev) => !prev);
  }, []);

  return (
    <SetupPlacementProvider value={setupPlacement}>
      <div className="flex h-dvh bg-background-admin dark:bg-background">
        <Sidebar
          orgName={orgName}
          adminName={adminName}
          adminEmail={adminEmail}
          role={role}
          setupPlacement={setupPlacement}
          isMobileOpen={isMobileOpen}
          onMobileClose={handleMobileClose}
        />
        <div className="flex flex-1 flex-col overflow-hidden">
          <AdminHeader onMenuClick={handleMenuClick} title={mobileTitle} orgName={orgName} />
          {billingAttention && (
            <div
              role="alert"
              className="flex items-center gap-3 border-b border-warning/40 bg-warning-light px-4 py-3 text-sm text-warning-foreground"
            >
              <AlertTriangle className="size-4 shrink-0" />
              <span className="flex-1">
                Your subscription needs attention — update billing to restore full
                access.
              </span>
              <Link
                href="/admin/settings/billing"
                className="shrink-0 font-medium underline underline-offset-2 hover:no-underline"
              >
                Update billing
              </Link>
            </div>
          )}
          <GlobalSearch placement={setupPlacement} />
          <main className="flex-1 overflow-auto">{children}</main>
        </div>
      </div>
    </SetupPlacementProvider>
  );
}
