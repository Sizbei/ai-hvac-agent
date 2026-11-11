'use client';

import { PreviewBanner } from '@/components/admin/preview-banner';
import { usePreviewSync } from '@/hooks/use-preview-sync';
import type { TechPreviewBanner as Props } from '@/lib/tech/tech-preview';

/**
 * "View as" a technician (spec P7): the admin banner and its sync on /tech —
 * reload at the cookie's expiry, and on returning to the tab when the server's
 * preview state (`/api/admin/preview/status`) differs from this page's.
 */
export function TechPreviewBanner({ line, targetUserId, exp }: Props) {
  usePreviewSync(true, true, targetUserId, exp);
  return <PreviewBanner line={line} />;
}
