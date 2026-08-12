import Link from 'next/link';
import { Suspense } from 'react';
import { Loader2, Wind } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { resolveInviteByToken } from '@/lib/admin/invites';
import { AcceptForm } from './accept-form';

interface PageProps {
  // Next.js (this version): dynamic route params are a Promise.
  readonly params: Promise<{ token: string }>;
}

/**
 * Public invite-accept page. Resolves the token server-side; on success renders
 * the set-name+password form (email read-only). On ANY failure (unknown,
 * expired, used, revoked) it shows ONE generic "no longer valid" card — no
 * distinction is surfaced, so a probe can't enumerate invites.
 *
 * The token never leaves the server except as the value already in the URL the
 * recipient was given; we pass it to the client form only to submit on accept.
 */
export default function InviteAcceptPage({ params }: PageProps) {
  return (
    <Suspense fallback={<InviteAcceptLoading />}>
      <InviteAcceptContent params={params} />
    </Suspense>
  );
}

async function InviteAcceptContent({ params }: PageProps) {
  const { token } = await params;
  const resolved = await resolveInviteByToken(token);

  if (!resolved.ok) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
        <Card className="w-full max-w-sm">
          <CardHeader className="space-y-1 text-center">
            <div className="mx-auto flex size-10 items-center justify-center rounded-lg bg-surface-sunken">
              <Wind className="size-5 text-foreground-faint" />
            </div>
            <CardTitle>Invitation unavailable</CardTitle>
            <CardDescription>
              This invitation is no longer valid. It may have expired, been used,
              or been revoked. Ask your administrator to send a new one.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/admin/login"
              className={buttonVariants({
                variant: 'outline',
                className: 'h-10 w-full',
              })}
            >
              Go to sign in
            </Link>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <AcceptForm
      token={token}
      email={resolved.invite.email}
      role={resolved.invite.role}
    />
  );
}

function InviteAcceptLoading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-1 text-center">
          <Loader2 className="mx-auto size-6 animate-spin text-foreground-faint" />
        </CardHeader>
      </Card>
    </div>
  );
}
