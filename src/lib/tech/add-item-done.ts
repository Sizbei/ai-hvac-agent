/** "Done" on the Add item sheet (M3c spec §7.1): add the pending pick first, never drop it. */
export type DoneAction = "wait" | "close" | "add_then_close";

export function doneAction(s: { readonly picked: boolean; readonly canRetry: boolean; readonly adding: boolean; readonly locked: boolean }): DoneAction {
  if (s.adding) return "wait";
  // The page is locked (recovery or an unknown write): keep the pick, don't drop it.
  if (s.picked && s.locked && !s.canRetry) return "wait";
  return s.picked && !s.canRetry ? "add_then_close" : "close";
}

/** Results are tappable only for the query on screen; older results wait for the new search (final review B P2-3). */
export function hitsUsable(hitsFor: string | null, q: string): boolean {
  return hitsFor !== null && hitsFor === q.trim();
}
