'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

function SuccessContent() {
  const searchParams = useSearchParams();
  const referenceNumber = searchParams.get('ref') ?? 'N/A';
  // Present only when a concrete window was reserved (see chat page). Absent →
  // soft booking, keep the "being processed" copy — never promise a time we
  // didn't hold.
  const windowLabel = searchParams.get('window');

  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <CheckCircle className="size-16 text-success" strokeWidth={1.5} />

        <div className="space-y-2">
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            {windowLabel ? "You're booked!" : 'Service Request Submitted!'}
          </h1>
          <p className="text-[15px] text-muted-foreground">
            {windowLabel
              ? `We've got you down for ${windowLabel}.`
              : 'Your request has been received and is being processed.'}
          </p>
        </div>

        <Card className="w-full">
          <CardContent className="flex flex-col items-center gap-1 pt-2">
            <span className="text-xs font-medium text-muted-foreground">
              Reference Number
            </span>
            <span className="font-mono text-lg font-semibold tabular-nums tracking-wide">
              {referenceNumber}
            </span>
          </CardContent>
        </Card>

        <p className="text-[15px] leading-6 text-muted-foreground">
          {windowLabel
            ? "We'll see you then — our team will be in touch if anything changes. "
            : 'Our team will follow up with you to coordinate the details. '}
          For an emergency, call us any time, day or night, at{' '}
          <span className="font-mono font-medium tabular-nums text-foreground">423-854-9505</span>.
        </p>

        <div className="flex flex-col items-center gap-3">
          <Button render={<Link href="/chat" />} className="h-11 text-sm">Start New Chat</Button>
          <Link
            href="/"
            className="text-sm text-link underline-offset-4 hover:underline"
          >
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}

function SuccessFallback() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <Skeleton className="size-16 rounded-md" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-20 w-full" />
      </div>
    </div>
  );
}

export default function SuccessPage() {
  return (
    <Suspense fallback={<SuccessFallback />}>
      <SuccessContent />
    </Suspense>
  );
}
