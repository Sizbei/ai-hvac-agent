import type { Metadata } from 'next';
import Link from 'next/link';
import { FileQuestion } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { ErrorState } from '@/components/admin/ui/error-state';

export const metadata: Metadata = { title: 'Page not found' };

/** Site-wide 404 for any URL no route matches (admin URLs get the in-shell one). */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-1 items-center justify-center bg-background px-4">
      <ErrorState
        icon={FileQuestion}
        title="We couldn’t find that page"
        description="It may have moved, or the link may be out of date."
        action={
          <Link href="/" className={buttonVariants()}>
            Go to the home page
          </Link>
        }
      />
    </main>
  );
}
