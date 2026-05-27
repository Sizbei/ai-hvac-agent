'use client';

import { useState, useCallback } from 'react';
import { Sidebar } from '@/components/admin/sidebar';
import { AdminHeader } from '@/components/admin/admin-header';

interface DashboardShellProps {
  readonly adminName: string;
  readonly adminEmail: string;
  readonly children: React.ReactNode;
}

export function DashboardShell({
  adminName,
  adminEmail,
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
    <div className="flex h-dvh bg-slate-50">
      <Sidebar
        adminName={adminName}
        adminEmail={adminEmail}
        isMobileOpen={isMobileOpen}
        onMobileClose={handleMobileClose}
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        <AdminHeader onMenuClick={handleMenuClick} />
        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
