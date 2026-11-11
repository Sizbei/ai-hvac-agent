import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getViewerContext } from '@/lib/auth/viewer';
import { isPlatformManagedOrg } from '@/lib/auth/authz';
import { billingPageView, seesPlatformUi } from '@/lib/admin/preview-view';
import { readHistoryContact } from '@/lib/admin/admin-guide-queries';
import { HISTORY_CONTACT_FALLBACK } from '@/lib/admin/admin-guide-state';
import { errorCode, logger } from '@/lib/logger';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';
import { InfoBanner } from '@/components/admin/ui/info-banner';
import { BillingPanel } from '@/components/admin/settings/billing-panel';

/** The platform owner's display name; the generic fallback on a read error. */
async function billingContact(organizationId: string): Promise<string> {
  try {
    return await readHistoryContact(organizationId);
  } catch (error) {
    logger.error({ code: errorCode(error), organizationId }, 'Billing contact read failed');
    return HISTORY_CONTACT_FALLBACK;
  }
}

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
  const { organizationId } = viewer.session;
  const view = billingPageView({
    uiRole: viewer.uiRole,
    platformUi: seesPlatformUi(viewer),
    platformManagedOrg: isPlatformManagedOrg(organizationId),
  });
  if (view === 'redirect') redirect('/admin/settings');

  const back = (
    <Button variant="outline" render={<Link href="/admin/settings" />}>
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to settings
    </Button>
  );

  if (view === 'handled') {
    const contact = await billingContact(organizationId);
    return (
      <PageShell narrow>
        <PageHeader title="Billing" actions={back} />
        <InfoBanner>Billing is handled by {contact}.</InfoBanner>
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
