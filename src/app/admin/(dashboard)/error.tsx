'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

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
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <Card className="flex max-w-md flex-col items-center gap-5 p-8 text-center">
        <div className="space-y-1.5">
          <h2 className="font-heading text-xl font-semibold tracking-tight">
            Something went wrong
          </h2>
          <p className="text-sm text-muted-foreground">
            An unexpected error occurred in the admin panel. You can try again
            or return to the dashboard.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-3">
          <Button onClick={reset}>Try again</Button>
          <Button variant="outline" render={<Link href="/admin" />}>
            Go to dashboard
          </Button>
        </div>
      </Card>
    </div>
  );
}
