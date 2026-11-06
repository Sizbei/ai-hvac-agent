/**
 * Pure rules behind the "unsaved changes" guard: is a draft different from
 * what's saved, and should a link click be held until the user confirms
 * leaving. The React side lives in `src/hooks/use-unsaved-changes-guard.ts`
 * (page leave) and in each dialog's own close handler (Esc / X / Cancel).
 */

type DraftValue = string | number | boolean | null | undefined | readonly (string | number)[];

function sameValue(a: DraftValue, b: DraftValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    // Order-insensitive: callers pass Sets as arrays.
    const sortedA = [...a].map(String).sort();
    const sortedB = [...b].map(String).sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  }
  return Object.is(a, b);
}

/** True when any field of the draft differs from the saved baseline. */
export function hasUnsavedChanges(
  saved: Readonly<Record<string, DraftValue>>,
  draft: Readonly<Record<string, DraftValue>>,
): boolean {
  const keys = new Set([...Object.keys(saved), ...Object.keys(draft)]);
  for (const key of keys) {
    if (!sameValue(saved[key], draft[key])) return true;
  }
  return false;
}

export interface LinkClick {
  readonly dirty: boolean;
  /** The anchor's resolved href (absolute). */
  readonly href: string;
  /** window.location.href at click time. */
  readonly currentUrl: string;
  readonly button: number;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** The anchor's target attribute ('' when none). */
  readonly target: string;
  readonly download: boolean;
}

/**
 * Hold this click and ask first? Only a plain left click on a same-origin
 * link to a different page, while there are unsaved changes. New-tab clicks,
 * downloads, external links and in-page anchors (same path) pass through.
 */
export function shouldHoldLinkClick(click: LinkClick): boolean {
  if (!click.dirty) return false;
  if (click.button !== 0) return false;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return false;
  if (click.download) return false;
  if (click.target !== '' && click.target !== '_self') return false;
  let next: URL;
  let current: URL;
  try {
    next = new URL(click.href);
    current = new URL(click.currentUrl);
  } catch {
    return false;
  }
  if (next.origin !== current.origin) return false;
  return next.pathname !== current.pathname;
}

export const LEAVE_UNSAVED_TITLE = 'Leave without saving?';
export const LEAVE_UNSAVED_COPY = "You have changes you haven't saved. They'll be lost if you leave this page.";
