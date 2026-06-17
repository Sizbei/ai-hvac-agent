'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

/**
 * Top-level error boundary — catches errors thrown in the root layout that the
 * route-segment `error.tsx` cannot. Must render its own <html>/<body>.
 *
 * DEGRADE-SAFE: Sentry.captureException is inert when Sentry was never
 * initialized (no NEXT_PUBLIC_SENTRY_DSN), so this behaves as a plain error
 * page without a DSN.
 */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div
          style={{
            display: 'flex',
            minHeight: '100dvh',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1.5rem',
            textAlign: 'center',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <div>
            <h1 style={{ fontSize: '1.25rem', fontWeight: 600 }}>
              Something went wrong
            </h1>
            <p style={{ marginTop: '0.5rem', color: '#6b7280' }}>
              An unexpected error occurred. Please reload the page.
            </p>
          </div>
        </div>
      </body>
    </html>
  );
}
