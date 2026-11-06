'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { shouldHoldLinkClick } from '@/lib/admin/unsaved-changes';

interface UnsavedChangesGuard {
  /** Where the user tried to go; non-null while the "Leave?" confirm is open. */
  readonly pendingHref: string | null;
  readonly stay: () => void;
  readonly leave: () => void;
}

/**
 * While `dirty`, asks before the page is left: a reload or tab close gets the
 * browser's own prompt (beforeunload), and a click on an in-app link (the
 * sidebar, a breadcrumb…) is held until the caller's confirm dialog answers.
 * Listens at the document in the capture phase, so no link component needs
 * to know about it.
 */
export function useUnsavedChangesGuard(dirty: boolean): UnsavedChangesGuard {
  const router = useRouter();
  const [pendingHref, setPendingHref] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) return;

    function onBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault();
      // Older browsers need returnValue set to show the prompt.
      event.returnValue = '';
    }

    function onClick(event: MouseEvent): void {
      const anchor = (event.target as Element | null)?.closest?.('a[href]');
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const hold = shouldHoldLinkClick({
        dirty: true,
        href: anchor.href,
        currentUrl: window.location.href,
        button: event.button,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        shiftKey: event.shiftKey,
        altKey: event.altKey,
        target: anchor.target,
        download: anchor.hasAttribute('download'),
      });
      if (!hold) return;
      event.preventDefault();
      event.stopPropagation();
      const url = new URL(anchor.href);
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    }

    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  return {
    pendingHref,
    stay: () => setPendingHref(null),
    leave: () => {
      const href = pendingHref;
      setPendingHref(null);
      if (href) router.push(href);
    },
  };
}

/** Tells a parent whenever a child form's dirty flag flips (settings panels). */
export function useReportDirty(
  dirty: boolean,
  onDirtyChange: ((dirty: boolean) => void) | undefined,
): void {
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
}
