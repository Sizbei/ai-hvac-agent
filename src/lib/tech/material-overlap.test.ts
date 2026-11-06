import { describe, it, expect } from "vitest";
import { materialOverlapWarning, OVERLAP_WARNING, soldPricebookItemIds } from "./material-overlap";
import type { TechEstimatesView } from "./estimate-view";

const est = (status: string, soldOptionId: string | null, options: { id: string; items: (string | null)[] }[]) => ({
  status, soldOptionId,
  options: options.map((o) => ({ id: o.id, lines: o.items.map((p, i) => ({ id: `${o.id}-${i}`, pricebookItemId: p })) })),
});

describe("materials overlap warning (spec §7.4)", () => {
  it("collects the sold option's pricebook items only", () => {
    const view = { estimates: [
      est("sold", "b", [{ id: "a", items: ["p1"] }, { id: "b", items: ["p2", null] }]),
      est("open", null, [{ id: "c", items: ["p3"] }]),
    ] } as unknown as Pick<TechEstimatesView, "estimates">;
    expect([...soldPricebookItemIds(view)]).toEqual(["p2"]);
    expect(soldPricebookItemIds(null).size).toBe(0);
  });
  it("warns only for a catalog pick that is on a sold estimate", () => {
    const ids = new Set(["p2"]);
    expect(materialOverlapWarning(ids, "p2")).toBe(OVERLAP_WARNING);
    expect(OVERLAP_WARNING).toBe("This part is on the sold estimate. Add it only if it's extra.");
    expect(materialOverlapWarning(ids, "p9")).toBeNull();
    expect(materialOverlapWarning(ids, "")).toBeNull();
  });
});
