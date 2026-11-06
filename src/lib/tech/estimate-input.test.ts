import { describe, it, expect } from "vitest";
import { buildFieldEstimate, hasDuplicateNames, INT32_MAX, signatureNameOk, type PricedItem } from "./estimate-input";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const items = new Map<string, PricedItem>([
  [A, { id: A, name: "Capacitor", priceCents: 12_500, costCents: 4_000 }],
  [B, { id: B, name: "Condenser fan motor", priceCents: 48_000, costCents: 21_000 }],
]);
let n = 0;
const mint = () => `id-${String(++n).padStart(3, "0")}`;

describe("hasDuplicateNames", () => {
  it("is case-insensitive and trims", () => {
    expect(hasDuplicateNames(["Good", " good "])).toBe(true);
    expect(hasDuplicateNames(["Good", "Better", "Best"])).toBe(false);
  });
});

describe("signatureNameOk (portal rule)", () => {
  it.each([["Pat", true], [" P ", false], ["Jo", true], ["(admin)", false], [" (admin) ", false], ["x".repeat(200), true], ["x".repeat(201), false]])(
    "%j → %s", (name, ok) => expect(signatureNameOk(name)).toBe(ok),
  );
});

describe("buildFieldEstimate", () => {
  it("snapshots names, prices and costs; totals with tax; headline = the largest option", () => {
    n = 0;
    const r = buildFieldEstimate({ options: [
      { name: " Good ", lines: [{ pricebookItemId: A, quantity: 2 }] },
      { name: "Better", lines: [{ pricebookItemId: A, quantity: 1 }, { pricebookItemId: B, quantity: 1 }] },
    ] }, items, 825, mint);
    if (!r.ok) throw new Error("expected ok");
    expect(r.options.map((o) => [o.name, o.sortOrder, o.subtotalCents, o.taxCents, o.totalCents])).toEqual([
      ["Good", 0, 25_000, 2_063, 27_063],
      ["Better", 1, 60_500, 4_991, 65_491],
    ]);
    expect(r.totalCents).toBe(65_491);
    expect(r.lines[0]).toEqual({ id: "id-002", optionId: "id-001", pricebookItemId: A, name: "Capacitor", quantity: 2, unitPriceCents: 12_500, costCents: 4_000, lineTotalCents: 25_000 });
    // ids in build order: option, its lines, next option, its lines
    expect([r.options[0]!.id, r.lines[0]!.id, r.options[1]!.id, r.lines[1]!.id, r.lines[2]!.id]).toEqual(["id-001", "id-002", "id-003", "id-004", "id-005"]);
  });

  it("buildFieldEstimate refuses a deactivated item and keeps two lines of the same item", () => {
    n = 0;
    const twice = buildFieldEstimate({ options: [{ name: "Good", lines: [{ pricebookItemId: A, quantity: 1 }, { pricebookItemId: A, quantity: 3 }] }] }, items, 0, mint);
    expect(twice.ok && twice.lines.map((l) => l.quantity)).toEqual([1, 3]);
    const gone = buildFieldEstimate({ options: [{ name: "Good", lines: [{ pricebookItemId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", quantity: 1 }] }] }, items, 0, mint);
    expect(gone).toEqual({ ok: false, reason: "item_inactive" });
  });

  it("matches item ids case-insensitively", () => {
    const r = buildFieldEstimate({ options: [{ name: "Good", lines: [{ pricebookItemId: A.toUpperCase(), quantity: 1 }] }] }, items, 0, mint);
    expect(r.ok).toBe(true);
  });

  it("buildFieldEstimate refuses an option total over INT32_MAX", () => {
    const big = new Map<string, PricedItem>([[A, { id: A, name: "Chiller", priceCents: 2_200_000, costCents: 0 }]]);
    expect(buildFieldEstimate({ options: [{ name: "Good", lines: [{ pricebookItemId: A, quantity: 999 }] }] }, big, 0, mint))
      .toEqual({ ok: false, reason: "too_large" });
    const edge = new Map<string, PricedItem>([[A, { id: A, name: "Chiller", priceCents: 1_900_000, costCents: 0 }]]);
    // 999 × $19,000 = $18,981,000 subtotal + 825 bps tax = $20,546,932.50 → still fits
    expect(buildFieldEstimate({ options: [{ name: "Good", lines: [{ pricebookItemId: A, quantity: 999 }] }] }, edge, 825, mint).ok).toBe(true);
    expect(INT32_MAX).toBe(2_147_483_647);
  });
});
