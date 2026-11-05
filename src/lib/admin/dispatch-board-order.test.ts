import { describe, it, expect } from "vitest";
import { busyColumnsFirst } from "./dispatch-board-order";

const col = (name: string, n: number) => ({ name, jobs: Array.from({ length: n }, (_, i) => i) });

describe("busyColumnsFirst", () => {
  it("moves technicians with requests ahead, keeping each group's order", () => {
    const out = busyColumnsFirst([col("Avery", 0), col("Ben", 0), col("Sarah", 1), col("Zed", 2)]);
    expect(out.map((c) => c.name)).toEqual(["Sarah", "Zed", "Avery", "Ben"]);
  });
  it("does not mutate its input", () => {
    const input = [col("A", 0), col("B", 1)];
    busyColumnsFirst(input);
    expect(input.map((c) => c.name)).toEqual(["A", "B"]);
  });
  it("handles an empty board", () => {
    expect(busyColumnsFirst([])).toEqual([]);
  });
});
