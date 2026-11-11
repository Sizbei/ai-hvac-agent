import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { getViewerContext } from '@/lib/auth/viewer';
import { resolveBillingEntry } from '@/lib/admin/billing-entry-server';
import { billingHandledCopy } from '@/lib/admin/billing-entry';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { InfoBanner } from '@/components/admin/ui/info-banner';
import { BillingPanel } from '@/components/admin/settings/billing-panel';

/**
 * Billing settings — the org's own platform subscription. Visible to a
 * super_admin of the org (or a platform admin); the data + action endpoints are
 * themselves gated the same way, so the server is the authority. A non-eligible
 * admin is redirected away rather than shown an empty shell. In the platform's
 * own org (PLATFORM_ORG_ID) an org user, or the platform admin while "View as"
 * is on, is told who handles billing instead: no plan switching (spec P7, M11).
 */
export default async function BillingSettingsPage() {
  const viewer = await getViewerContext();
  if (!viewer) redirect('/admin/settings');
  const entry = await resolveBillingEntry(viewer);
  if (entry.view === 'redirect') redirect('/admin/settings');

  const back = (
    <Link href="/admin/settings" className={buttonVariants({ variant: 'outline' })}>
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to settings
    </Link>
  );

  if (entry.view === 'handled') {
    return (
      <PageShell narrow>
        <PageHeader title="Billing" actions={back} />
        <InfoBanner>{billingHandledCopy(entry)}</InfoBanner>
      </PageShell>
    );
  }

  return (
    <PageShell narrow>
      <PageHeader
        title="Billing"
        subtitle="See your plan and what it includes, upgrade, or change billing details."
        actions={back}
      />
      <BillingPanel />
    </PageShell>
  );
}
