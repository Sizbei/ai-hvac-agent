'use client';

import { useEffect } from 'react';
import {
  parsePreviewStatus,
  previewExpiryDelayMs,
  previewStatusDiffers,
} from '@/lib/admin/preview-sync';

/**
 * Runs in the admin shell whether or not a "View as" preview is on: reloads at
 * the cookie's expiry, and on returning to the tab when the server's preview
 * state differs from what this page shows (another tab started, exited or
 * switched a preview). Decisions live in `preview-sync.ts`.
 */
export function usePreviewSync(
  previewing: boolean,
  targetUserId: string | null,
  exp: number | null,
): void {
  useEffect(() => {
    const delay = previewExpiryDelayMs(exp, Date.now());
    if (delay === null) return;
    const timer = setTimeout(() => location.reload(), delay);
    return () => clearTimeout(timer);
  }, [exp]);

  useEffect(() => {
    const shown = { previewing, targetUserId };
    let checking = false;
    async function check() {
      if (document.visibilityState !== 'visible' || checking) return;
      checking = true;
      try {
        const res = await fetch('/api/admin/preview/status', { cache: 'no-store' });
        const json: unknown = await res.json().catch(() => null);
        if (previewStatusDiffers(shown, res.ok ? parsePreviewStatus(json) : null)) {
          location.reload();
        }
      } catch {
        // Offline or similar: keep the page; the next return to the tab re-checks.
      } finally {
        checking = false;
      }
    }
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [previewing, targetUserId]);
}
