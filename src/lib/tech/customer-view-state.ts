/**
 * The customer layer's history machine (M3c spec §7.2, plan ruling 13). Pure:
 * the estimate page applies `effect` with window.history — push =
 * pushState('#customer'); back = history.back(); strip = replaceState without
 * the hash; strip_push = strip, then push. Next 16 keeps its router state
 * across native pushState / replaceState.
 *
 * An open layer always owns exactly one '#customer' entry: Show to customer
 * pushes it, and a reload that reopens the layer strips the reloaded entry and
 * pushes a fresh one. So every close is one Back onto the estimate page, never
 * further.
 */
import { estimateWriteCopy, type EnvelopeLike } from "./estimate-intents";
import { saleResult } from "./estimate-page-copy";
import type { KeyPhase, WriteOutcome } from "./invoice-key-state";
import type { TechEstimate } from "./estimate-view";

export const CUSTOMER_HASH = "#customer";

export type LayerState = { readonly open: boolean };
export type LayerEvent =
  | { readonly type: "show" }
  | { readonly type: "mount"; readonly hash: string; readonly sellable: boolean }
  | { readonly type: "popstate"; readonly hash: string }
  | { readonly type: "close" };
export type LayerEffect = "push" | "back" | "strip" | "strip_push" | "none";

export const LAYER_CLOSED: LayerState = { open: false };
export const LAYER_OPEN: LayerState = { open: true };

export function layerStep(s: LayerState, e: LayerEvent): { state: LayerState; effect: LayerEffect } {
  switch (e.type) {
    case "show":
      return s.open ? { state: s, effect: "none" } : { state: LAYER_OPEN, effect: "push" };
    case "mount":
      if (s.open) return { state: s, effect: "none" }; // StrictMode's second mount
      if (e.hash !== CUSTOMER_HASH) return { state: LAYER_CLOSED, effect: "none" };
      return e.sellable ? { state: LAYER_OPEN, effect: "strip_push" } : { state: LAYER_CLOSED, effect: "strip" };
    case "popstate":
      if (e.hash === CUSTOMER_HASH) return s.open ? { state: s, effect: "none" } : { state: LAYER_CLOSED, effect: "strip" };
      return { state: LAYER_CLOSED, effect: "none" };
    case "close":
      return s.open ? { state: LAYER_CLOSED, effect: "back" } : { state: s, effect: "none" };
  }
}

/**
 * Approve's first answer (Task 9 fix round 1). A send that went nowhere (a sell
 * for this estimate is already in flight) or that re-sent an older stored sell
 * never counts as this choice's success: refetch and check.
 */
export function approveFirst(
  r: { readonly sent: false } | { readonly sent: true; readonly outcome: WriteOutcome; readonly resentOld: boolean },
): "success" | "check" | "failed" {
  if (!r.sent || r.resentOld) return "check";
  return saleResult(r.outcome);
}

/** The estimate left `open`, so a stored sell is settled (the server state moved). */
export function sellAdvanced(e: Pick<TechEstimate, "status"> | null): boolean {
  return e !== null && e.status !== "open";
}

/**
 * What the technician reads after a failed sale (the customer only ever sees
 * CUSTOMER_COPY.failed). Null when a re-sent older sell landed: the page then
 * shows that sold state, which is the reason.
 */
export function saleFailNote(
  r: { readonly sent: false } | { readonly sent: true; readonly outcome: WriteOutcome; readonly envelope: EnvelopeLike | null },
): string | null {
  if (!r.sent) return estimateWriteCopy("retry_same_key_after_refetch", null);
  if (r.outcome === "success_refetch" || r.outcome === "already_saved_refetch") return null;
  return estimateWriteCopy(r.outcome, r.envelope);
}

/** An open layer whose estimate a refetch removed or made unsellable closes, unless a sale started in it. */
export function layerStale(p: { readonly open: boolean; readonly saleStarted: boolean; readonly sellable: boolean }): boolean {
  return p.open && !p.saleStarted && !p.sellable;
}

/**
 * The estimate page is locked (final review B P1-1): during the mount recovery,
 * while a stored intent is unanswered, while any write runs, and while a sell is
 * in flight or unknown, even after Back closed the layer during "Approving…".
 */
export function pageLocked(p: {
  readonly recovering: boolean; readonly unresolved: number; readonly sellPhase: KeyPhase; readonly busy: string | null;
}): boolean {
  return p.recovering || p.unresolved > 0 || p.sellPhase === "sent" || p.sellPhase === "unknown" || p.busy !== null;
}

/**
 * Tab inside the customer layer (final review B P2-6): the index to move focus
 * to, or null to let the browser's Tab order run. `index` is the focused
 * control's place among the layer's tabbable controls, -1 when focus is
 * elsewhere (behind the layer, or on its heading).
 */
export function focusTrapTarget(p: { readonly index: number; readonly count: number; readonly shift: boolean }): number | null {
  if (p.count === 0) return null;
  const last = p.count - 1;
  if (p.index < 0) return p.shift ? last : 0;
  if (p.shift) return p.index === 0 ? last : null;
  return p.index === last ? 0 : null;
}

/** The technician's failure note shows only once the layer is closed, so it is never read out to the customer (Task 9 parked). */
export function techNoteVisible(p: { readonly note: string | null; readonly layerOpen: boolean; readonly banner: boolean }): boolean {
  return p.note !== null && !p.layerOpen && !p.banner;
}
