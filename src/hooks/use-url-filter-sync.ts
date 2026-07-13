'use client';

import { useEffect, useRef } from 'react';
import { toQueryString, fromQueryString } from '@/lib/admin/url-filters';

/**
 * Two-way sync between a page's filter state and the URL query string, using the
 * History API directly (NOT next/navigation's useSearchParams — that would force
 * a Suspense boundary and can break the build). Because it reads window.* only
 * inside effects (post-mount), there is no hydration mismatch.
 *
 * - On mount: reads the current URL and, if any params are present, calls
 *   `onRestore` once so the page can seed its filter state (survives refresh +
 *   makes filtered views shareable).
 * - On every change to the serialized `params`: replaceState the URL (no
 *   navigation, no scroll, no new history entry).
 *
 * `params` should map query-key → already-stringified value, with '' for any
 * filter at its default (those are dropped from the URL by toQueryString).
 */
export function useUrlFilterSync(
  params: Record<string, string | undefined>,
  onRestore: (parsed: Record<string, string>) => void,
): void {
  const restoredRef = useRef(false);

  // Restore once from the URL on mount. `onRestore` is expected to be a stable
  // useCallback, so a mount-only effect captures the right closure.
  useEffect(() => {
    const parsed = fromQueryString(window.location.search);
    if (Object.keys(parsed).length > 0) onRestore(parsed);
    restoredRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Write the URL whenever the serialized params change — but only after the
  // initial restore has run, so we never clobber the incoming URL with defaults.
  const qs = toQueryString(params);
  useEffect(() => {
    if (!restoredRef.current) return;
    const next = window.location.pathname + qs;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [qs]);
}
