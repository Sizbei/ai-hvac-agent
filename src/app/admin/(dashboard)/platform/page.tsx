import { redirect } from 'next/navigation';
import { getAdminSession } from '@/lib/auth/session';
import { isPlatformAdmin } from '@/lib/auth/authz';
import { PlatformConsole } from '@/components/admin/platform/platform-console';

/**
 * Platform tenant console — visible ONLY to platform admins (env allowlist).
 *
 * The dashboard layout already guarantees an admin session; here we additionally
 * gate on isPlatformAdmin and redirect a non-platform admin away (the API behind
 * the console is itself platform-gated, so the server is the authority either
 * way — this redirect just avoids rendering an empty shell).
 */
export default async function PlatformPage() {
  const session = await getAdminSession();
  if (!session || !isPlatformAdmin(session)) {
    redirect('/admin');
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Platform</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Provision new tenant organizations and view existing ones. Creating a
          tenant issues a one-time invite link for the owner to accept.
        </p>
      </div>
      <PlatformConsole />
    </div>
  );
}
