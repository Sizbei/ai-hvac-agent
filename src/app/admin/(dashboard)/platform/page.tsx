import { redirect } from 'next/navigation';
import { getViewerContext } from '@/lib/auth/viewer';
import { PlatformConsole, ViewAs } from '@/components/admin/platform/platform-console';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';

/**
 * Platform tenant console — visible ONLY to platform admins (env allowlist).
 *
 * The dashboard layout already guarantees an admin session; here we additionally
 * gate on isPlatformAdmin and redirect a non-platform admin away (the API behind
 * the console is itself platform-gated, so the server is the authority either
 * way — this redirect just avoids rendering an empty shell).
 */
export default async function PlatformPage() {
  const viewer = await getViewerContext();
  if (!viewer || !viewer.isPlatformAdmin) {
    redirect('/admin');
  }

  return (
    <PageShell>
      <PageHeader
        title="Platform"
        subtitle="Provision new tenant organizations and view existing ones. Creating a tenant issues a one-time invite link for the owner to accept."
      />
      {/* While a preview is on, the banner's Exit is the only control; a
          second start would be refused by the read-only proxy anyway. */}
      {viewer.preview === null && <ViewAs />}
      <PlatformConsole />
    </PageShell>
  );
}
