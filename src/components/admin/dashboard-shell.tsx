'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { Sidebar } from '@/components/admin/sidebar';
import { AdminHeader } from '@/components/admin/admin-header';
import { GlobalSearch } from '@/components/admin/global-search';
import { NAV_GROUPS } from '@/components/admin/nav-items';
import type { AdminRole } from '@/lib/auth/types';

interface DashboardShellProps {
  readonly adminName: string;
  readonly adminEmail: string;
  readonly role: AdminRole;
  /** When true, the org's subscription is past_due/suspended — render the
   * non-dismissable billing banner above the content. */
  readonly billingAttention?: boolean;
  readonly children: React.ReactNode;
}

/** Derive a page label from the current pathname by exact-matching nav items.
 *  Falls back to undefined (no title shown) if no match is found. */
function useMobileTitle(): string | undefined {
  const pathname = usePathname();
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      const match = item.exact
        ? pathname === item.href
        : pathname === item.href || pathname.startsWith(item.href + '/');
      if (match) return item.label;
    }
  }
  return undefined;
}

export function DashboardShell({
  adminName,
  adminEmail,
  role,
  billingAttention = false,
  children,
}: DashboardShellProps) {
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const mobileTitle = useMobileTitle();

  const handleMobileClose = useCallback(() => {
    setIsMobileOpen(false);
  }, []);

  const handleMenuClick = useCallback(() => {
    setIsMobileOpen((prev) => !prev);
  }, []);

  return (
    <div className="flex h-dvh bg-background-admin dark:bg-background">
      <Sidebar
        adminName={adminName}
        adminEmail={adminEmail}
        role={role}
        isMobileOpen={isMobileOpen}
        onMobileClose={handleMobileClose}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <AdminHeader onMenuClick={handleMenuClick} title={mobileTitle} />
        {billingAttention && (
          <div
            role="alert"
            className="flex items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
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
        <GlobalSearch />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
