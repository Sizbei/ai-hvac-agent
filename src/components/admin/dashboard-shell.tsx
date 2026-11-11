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
import { OrgNameProvider } from '@/components/admin/org-name-context';
import { PlatformUiProvider } from '@/components/admin/platform-ui-context';
import { BillingEntryProvider } from '@/components/admin/billing-entry-context';
import { PreviewBanner } from '@/components/admin/preview-banner';
import { usePreviewSync } from '@/hooks/use-preview-sync';
import { previewSyncEnabled } from '@/lib/admin/preview-sync';
import type { AdminRole } from '@/lib/auth/types';
import type { BillingEntry } from '@/lib/admin/billing-entry';

interface DashboardShellProps {
  readonly orgName?: string;
  /** The org's logo_url (server-decided); the brand mark falls back when null. */
  readonly logoUrl?: string | null;
  /** The account chip: the "View as" target's name and email while previewing. */
  readonly adminName: string;
  readonly adminEmail: string;
  /** The platform owner, not previewing: platform-only UI shows. */
  readonly platformUi: boolean;
  /** Billing links and "handled by" copy for this viewer (server-decided). */
  readonly billingEntry: BillingEntry;
  /** The role the UI renders for: the "View as" target's while previewing. */
  readonly role: AdminRole | 'technician';
  /** Set only while a "View as" preview is on: the banner line, the active
   * target (null when stale) and the cookie's expiry (unix seconds). */
  readonly preview?: {
    readonly line: string;
    readonly targetUserId: string | null;
    readonly exp: number;
  } | null;
  /** When true, the org's subscription is past_due/suspended — render the
   * non-dismissable billing banner above the content. */
  readonly billingAttention?: boolean;
  /** Server-decided position of the Setup nav item for this page load. */
  readonly setupPlacement: SetupPlacement;
  /** The org's Map switch (server-decided). */
  readonly mapEnabled: boolean;
  readonly children: React.ReactNode;
}

/** The current page's nav label for the mobile top bar (undefined if none). */
function useMobileTitle(placement: SetupPlacement, mapEnabled: boolean): string | undefined {
  return navLabelFor(usePathname(), placement, { map: mapEnabled });
}

export function DashboardShell({
  orgName,
  logoUrl,
  adminName,
  adminEmail,
  platformUi,
  billingEntry,
  role,
  preview = null,
  billingAttention = false,
  setupPlacement,
  mapEnabled,
  children,
}: DashboardShellProps) {
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const mobileTitle = useMobileTitle(setupPlacement, mapEnabled);
  usePreviewSync(
    previewSyncEnabled({ platformUi, previewing: preview !== null }),
    preview !== null,
    preview?.targetUserId ?? null,
    preview?.exp ?? null,
  );

  const handleMobileClose = useCallback(() => {
    setIsMobileOpen(false);
  }, []);

  const handleMenuClick = useCallback(() => {
    setIsMobileOpen((prev) => !prev);
  }, []);

  return (
    <SetupPlacementProvider value={setupPlacement}>
      <OrgNameProvider value={orgName}>
        <PlatformUiProvider value={platformUi}>
          <BillingEntryProvider value={billingEntry}>
            <div className="flex h-dvh bg-background-admin dark:bg-background">
              <Sidebar
                orgName={orgName}
                logoUrl={logoUrl}
                adminName={adminName}
                adminEmail={adminEmail}
                role={role}
                setupPlacement={setupPlacement}
                mapEnabled={mapEnabled}
                isMobileOpen={isMobileOpen}
                onMobileClose={handleMobileClose}
              />
              <div className="flex flex-1 flex-col overflow-hidden">
                {preview && <PreviewBanner line={preview.line} />}
                <AdminHeader onMenuClick={handleMenuClick} title={mobileTitle} orgName={orgName} logoUrl={logoUrl} />
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
                <GlobalSearch placement={setupPlacement} mapEnabled={mapEnabled} />
                <main className="flex-1 overflow-auto">{children}</main>
              </div>
            </div>
          </BillingEntryProvider>
        </PlatformUiProvider>
      </OrgNameProvider>
    </SetupPlacementProvider>
  );
}
