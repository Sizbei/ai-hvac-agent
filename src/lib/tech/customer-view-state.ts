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
