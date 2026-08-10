'use client';

import { Analytics } from '@vercel/analytics/next';
import { maskTokenPath } from '@/lib/analytics-path';

/**
 * `<Analytics/>` with token-bearing paths masked before anything is sent.
 *
 * This wrapper exists because `beforeSend` is a function prop, which cannot
 * cross the server→client boundary — the root layout is a Server Component.
 * Scoping `<Analytics/>` away from the token routes instead is not possible:
 * a nested layout renders INSIDE its ancestor and cannot remove JSX the root
 * layout already emitted.
 *
 * Masking logic (and its tests) live in `@/lib/analytics-path`.
 */
export function MaskedAnalytics() {
  return (
    <Analytics
      beforeSend={(event) => ({ ...event, url: maskTokenPath(event.url) })}
    />
  );
}
