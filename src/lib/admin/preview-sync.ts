/**
 * Keeps the "View as" banner honest (spec P7: banner and behaviour never
 * disagree). The banner lives in the persistent admin layout, so it reloads
 * the page when the cookie expires, and on returning to the tab when the
 * server's preview state differs from what is on screen (a preview started,
 * exited or switched in another tab). Pure: no DOM, no fetch.
 */
import type { PreviewState } from "@/lib/auth/viewer";

/** What the page shows, and what `GET /api/admin/preview/status` returns. */
export interface PreviewStatus {
  readonly previewing: boolean;
  /** The active target; null when not previewing or the target is stale. */
  readonly targetUserId: string | null;
}

/** The slack after `exp`, so the reload lands after the server sees it expired. */
const EXPIRY_SLACK_MS = 1000;

export function shownPreview(p: PreviewState | null): PreviewStatus {
  if (!p) return { previewing: false, targetUserId: null };
  return { previewing: true, targetUserId: p.status === "active" ? p.targetUserId : null };
}

/** Milliseconds until the expiry reload; null when not previewing. */
export function previewExpiryDelayMs(exp: number | null, nowMs: number): number | null {
  if (exp === null) return null;
  return Math.max(0, exp * 1000 - nowMs) + EXPIRY_SLACK_MS;
}

/** True when the server's state differs from the page's; an unreadable status never reloads. */
export function previewStatusDiffers(shown: PreviewStatus, status: PreviewStatus | null): boolean {
  if (status === null) return false;
  return shown.previewing !== status.previewing || shown.targetUserId !== status.targetUserId;
}

/** The status route's success envelope, or null for anything else. */
export function parsePreviewStatus(json: unknown): PreviewStatus | null {
  if (typeof json !== "object" || json === null) return null;
  const { success, data } = json as { success?: unknown; data?: unknown };
  if (success !== true || typeof data !== "object" || data === null) return null;
  const { previewing, targetUserId } = data as Record<string, unknown>;
  if (typeof previewing !== "boolean") return null;
  if (targetUserId !== null && typeof targetUserId !== "string") return null;
  return { previewing, targetUserId };
}
