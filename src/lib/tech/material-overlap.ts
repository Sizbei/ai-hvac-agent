/** The material form's warning when a part is already on a sold estimate (M3c spec §7.4). Pure. */
import type { TechEstimatesView } from "./estimate-view";

export const OVERLAP_WARNING = "This part is on the sold estimate. Add it only if it's extra.";

export function soldPricebookItemIds(view: Pick<TechEstimatesView, "estimates"> | null): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const e of view?.estimates ?? []) {
    if (e.status !== "sold") continue;
    const sold = e.options.find((o) => o.id === e.soldOptionId);
    for (const l of sold?.lines ?? []) if (l.pricebookItemId) ids.add(l.pricebookItemId);
  }
  return ids;
}

export function materialOverlapWarning(soldIds: ReadonlySet<string>, selectedItemId: string): string | null {
  return selectedItemId !== "" && soldIds.has(selectedItemId) ? OVERLAP_WARNING : null;
}
