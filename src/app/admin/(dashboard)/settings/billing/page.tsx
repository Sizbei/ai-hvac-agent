import { redirect } from 'next/navigation';
import { getAdminSession } from '@/lib/auth/session';
import { isSuperAdmin, isPlatformAdmin } from '@/lib/auth/authz';
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
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your platform subscription, see your plan&apos;s entitlements,
          and upgrade or change billing details.
        </p>
      </div>
      <BillingPanel />
    </div>
  );
}
