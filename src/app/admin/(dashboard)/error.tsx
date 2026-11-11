'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button, buttonVariants } from '@/components/ui/button';
import { PageShell } from '@/components/admin/ui/page-shell';
import { ErrorState } from '@/components/admin/ui/error-state';

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[admin] unhandled error:', error.message);
  }, [error]);

  return (
    <PageShell narrow>
      <ErrorState
        title="Something went wrong"
        description="An unexpected error occurred in the admin panel. You can try again or return to the dashboard."
        action={
          <div className="flex flex-wrap justify-center gap-3">
            <Button onClick={reset}>Try again</Button>
            <Link href="/admin" className={buttonVariants({ variant: 'outline' })}>
              Go to dashboard
            </Link>
          </div>
        }
      />
    </PageShell>
  );
}
