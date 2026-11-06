/** "Done" on the Add item sheet (M3c spec §7.1): add the pending pick first, never drop it. */
export type DoneAction = "wait" | "close" | "add_then_close";

export function doneAction(s: { readonly picked: boolean; readonly canRetry: boolean; readonly adding: boolean }): DoneAction {
  if (s.adding) return "wait";
  return s.picked && !s.canRetry ? "add_then_close" : "close";
}
