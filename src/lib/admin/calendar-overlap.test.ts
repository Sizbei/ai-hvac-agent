import { describe, it, expect } from "vitest";
import { overlapColumns } from "./calendar-overlap";

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
