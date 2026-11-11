import { notFound } from 'next/navigation';
import { getViewerContext } from '@/lib/auth/viewer';
import { seesPlatformUi } from '@/lib/admin/preview-view';
import { PlatformConsole, ViewAs } from '@/components/admin/platform/platform-console';
import { PageShell } from '@/components/admin/ui/page-shell';
import { PageHeader } from '@/components/admin/ui/page-header';

/**
 * Platform tenant console — visible ONLY to platform admins (env allowlist).
 *
 * The dashboard layout already guarantees an admin session; here we additionally
 * gate on isPlatformAdmin. A non-platform viewer gets a 404, and so does the
 * platform admin while a "View as" preview is on (spec P7: the preview applies
 * the target's P3 gates). The APIs behind the console keep the real session's
 * platform gate; this only decides what renders.
 */
export default async function PlatformPage() {
  const viewer = await getViewerContext();
  if (!viewer || !seesPlatformUi(viewer)) {
    notFound();
  }

  return (
    <PageShell>
      <PageHeader
        title="Platform"
        subtitle="Provision new tenant organizations and view existing ones. Creating a tenant issues a one-time invite link for the owner to accept."
      />
      <ViewAs />
      <PlatformConsole />
    </PageShell>
  );
}
