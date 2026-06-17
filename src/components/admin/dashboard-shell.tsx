'use client';

import { useState, useCallback } from 'react';
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { Sidebar } from '@/components/admin/sidebar';
import { AdminHeader } from '@/components/admin/admin-header';

interface DashboardShellProps {
  readonly adminName: string;
  readonly adminEmail: string;
  /** When true, the org's subscription is past_due/suspended — render the
   * non-dismissable billing banner above the content. */
  readonly billingAttention?: boolean;
  readonly children: React.ReactNode;
}

export function DashboardShell({
  adminName,
  adminEmail,
  billingAttention = false,
  children,
}: DashboardShellProps) {
  const [isMobileOpen, setIsMobileOpen] = useState(false);

  const handleMobileClose = useCallback(() => {
    setIsMobileOpen(false);
  }, []);

  const handleMenuClick = useCallback(() => {
    setIsMobileOpen((prev) => !prev);
  }, []);

  return (
    <div className="flex h-dvh bg-[oklch(0.97_0.006_240)] dark:bg-background">
      <Sidebar
        adminName={adminName}
        adminEmail={adminEmail}
        isMobileOpen={isMobileOpen}
        onMobileClose={handleMobileClose}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <AdminHeader onMenuClick={handleMenuClick} />
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
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
