import { describe, it, expect } from "vitest";
import { cappedOverlapColumns, overlapColumns } from "./calendar-overlap";

describe("overlapColumns", () => {
  it("gives a lone card the whole lane", () => {
    expect(overlapColumns([{ top: 0, bottom: 100 }])).toEqual([{ column: 0, columns: 1 }]);
  });

  it("puts two identical windows (a double-booking) side by side", () => {
    expect(overlapColumns([{ top: 448, bottom: 672 }, { top: 448, bottom: 672 }])).toEqual([
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
    ]);
  });

  it("cards that only touch don't share columns", () => {
    expect(overlapColumns([{ top: 0, bottom: 224 }, { top: 224, bottom: 448 }])).toEqual([
      { column: 0, columns: 1 },
      { column: 0, columns: 1 },
    ]);
  });

  it("a chain shares one column count and reuses a freed column", () => {
    // A overlaps B, B overlaps C, A and C don't: two columns, C reuses A's.
    const slots = overlapColumns([
      { top: 0, bottom: 100 },
      { top: 50, bottom: 150 },
      { top: 120, bottom: 200 },
    ]);
    expect(slots).toEqual([
      { column: 0, columns: 2 },
      { column: 1, columns: 2 },
      { column: 0, columns: 2 },
    ]);
  });

  it("keeps the input order and handles separate clusters independently", () => {
    const slots = overlapColumns([
      { top: 300, bottom: 400 },
      { top: 0, bottom: 100 },
      { top: 0, bottom: 100 },
      { top: 0, bottom: 100 },
    ]);
    expect(slots[0]).toEqual({ column: 0, columns: 1 });
    expect(slots.slice(1).map((s) => s.column).sort()).toEqual([0, 1, 2]);
    expect(slots.slice(1).every((s) => s.columns === 3)).toBe(true);
  });

  it("empty in, empty out", () => {
    expect(overlapColumns([])).toEqual([]);
  });
});

describe("cappedOverlapColumns", () => {
  const hour = (h: number, len = 1) => ({ top: h * 56, bottom: (h + len) * 56 });
  const BAR = 20;

  it("leaves a cluster that fits alone", () => {
    const { slots, overflow } = cappedOverlapColumns([hour(8), hour(8)], 2, BAR);
    expect(slots).toEqual([
      { column: 0, columns: 2, hidden: false },
      { column: 1, columns: 2, hidden: false },
    ]);
    expect(overflow).toEqual([]);
  });

  it("shows one full-width card and a bar counting the rest", () => {
    const spans = [hour(8, 2), hour(8, 2), hour(8, 2), hour(8, 2), hour(9)];
    const { slots, overflow } = cappedOverlapColumns(spans, 2, BAR);
    const shown = slots.filter((s) => !s.hidden);
    expect(shown).toEqual([{ column: 0, columns: 1, hidden: false, bottom: 10 * 56 - BAR - 2 }]);
    expect(overflow).toEqual([{ top: 10 * 56 - BAR, bottom: 10 * 56, count: 4 }]);
  });

  it("a shown card that ends above the bar keeps its height", () => {
    // The 8-9 card takes column 0; a later 8:30-11 card pushes the bar to 11.
    const { slots, overflow } = cappedOverlapColumns([hour(8), hour(8.5, 2.5), hour(8.5, 0.5)], 2, BAR);
    // The bar sits right under the shown card, not down at 11.
    expect(overflow).toEqual([{ top: 9 * 56 + 2, bottom: 9 * 56 + 2 + BAR, count: 2 }]);
    const shown = slots.filter((s) => !s.hidden);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.bottom).toBeUndefined();
  });

  it("gives each crowded cluster its own bar and leaves quiet ones alone", () => {
    const spans = [hour(8), hour(8), hour(8), hour(13), hour(15), hour(15), hour(15)];
    const { slots, overflow } = cappedOverlapColumns(spans, 2, BAR);
    expect(slots[3]).toEqual({ column: 0, columns: 1, hidden: false });
    expect(overflow.map((t) => [t.bottom, t.count])).toEqual([
      [9 * 56, 2],
      [16 * 56, 2],
    ]);
    // Every card is either shown or counted once.
    const shown = slots.filter((s) => !s.hidden).length;
    expect(shown + overflow.reduce((n, t) => n + t.count, 0)).toBe(spans.length);
  });

  it("an uncapped lane is plain overlapColumns", () => {
    const spans = [hour(8), hour(8), hour(8), hour(8)];
    const { slots, overflow } = cappedOverlapColumns(spans, Number.POSITIVE_INFINITY, BAR);
    expect(overflow).toEqual([]);
    expect(slots.map(({ column, columns }) => ({ column, columns }))).toEqual(overlapColumns(spans));
  });
});
