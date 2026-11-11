'use client';

import { useEffect, useRef, type RefObject } from 'react';

/** How long to keep nudging toward the saved position while rows paint. */
const RESTORE_WINDOW_MS = 1500;

/**
 * The admin scrolls inside <main>, not the window, so the browser cannot
 * restore scroll on Back/Forward the way it does for a normal page. This keeps
 * the last scroll position per path and puts it back when the user arrives by
 * Back/Forward; a normal (forward) navigation starts at the top.
 */
export function useMainScrollRestore(
  ref: RefObject<HTMLElement | null>,
  pathname: string,
): void {
  const positions = useRef(new Map<string, number>());
  // Path a Back/Forward is heading to; cleared on the next path change.
  const poppedTo = useRef<string | null>(null);

  useEffect(() => {
    const onPopState = () => {
      poppedTo.current = window.location.pathname;
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const restoring = poppedTo.current === pathname;
    poppedTo.current = null;
    const target = restoring ? (positions.current.get(pathname) ?? 0) : 0;

    // Rows may still be painting (cached lists land within a frame or two), so
    // keep applying the target until it sticks or the window closes. Any scroll
    // the user makes themselves ends the restore.
    let cancelled = false;
    const startedAt = Date.now();
    const apply = () => {
      if (cancelled) return;
      el.scrollTop = target;
      if (Math.abs(el.scrollTop - target) > 1 && Date.now() - startedAt < RESTORE_WINDOW_MS) {
        requestAnimationFrame(apply);
      }
    };
    apply();
    const stop = () => {
      cancelled = true;
    };
    el.addEventListener('wheel', stop, { passive: true });
    el.addEventListener('touchmove', stop, { passive: true });

    const onScroll = () => positions.current.set(pathname, el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelled = true;
      el.removeEventListener('wheel', stop);
      el.removeEventListener('touchmove', stop);
      el.removeEventListener('scroll', onScroll);
    };
  }, [ref, pathname]);
}
