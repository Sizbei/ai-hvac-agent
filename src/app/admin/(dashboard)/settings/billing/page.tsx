import { redirect } from 'next/navigation';
import { getAdminSession } from '@/lib/auth/session';
import { isSuperAdmin, isPlatformAdmin } from '@/lib/auth/authz';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { BillingPanel } from '@/components/admin/settings/billing-panel';

/**
 * Billing settings — the org's own platform subscription. Visible to a
 * super_admin of the org (or a platform admin); the data + action endpoints are
 * themselves gated the same way, so the server is the authority. A non-eligible
 * admin is redirected away rather than shown an empty shell.
 */
export default async function BillingSettingsPage() {
  const session = await getAdminSession();
  if (!session || (!isSuperAdmin(session) && !isPlatformAdmin(session))) {
    redirect('/admin/settings');
  }

  return (
    <PageShell narrow>
      <PageHeader
        title="Billing"
        subtitle="Manage your platform subscription, see your plan's entitlements, and upgrade or change billing details."
      />
      <BillingPanel />
    </PageShell>
  );
}
