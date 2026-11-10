import { describe, it, expect } from "vitest";
import { navGroupsFor } from "@/components/admin/nav-items";
import { LATENCY_PAGES, formatLatencyTable, percentile } from "./latency-stats";

describe("percentile (nearest-rank)", () => {
  it("returns the median and p90 of an unsorted sample", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
  });

  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    percentile(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });

  it("handles a single sample and p0", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7, 9], 0)).toBe(7);
  });

  it("returns NaN for an empty sample", () => {
    expect(percentile([], 50)).toBeNaN();
  });
});

describe("formatLatencyTable", () => {
  const table = formatLatencyTable([
    { path: "/admin/requests", frame: [10, 20, 30], firstRow: [400, 500, 900] },
    { path: "/admin/invoices", frame: [5], firstRow: [] },
  ]);
  const lines = table.split("\n");

  it("has a header plus one row per path", () => {
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("frame p50");
    expect(lines[1]).toContain("/admin/requests");
    expect(lines[2]).toContain("/admin/invoices");
  });

  it("shows p50 and p90 in ms and a dash for no samples", () => {
    expect(lines[1]).toMatch(/20\s+30\s+500\s+900/);
    expect(lines[2]).toMatch(/5\s+5\s+-\s+-/);
  });

  it("aligns columns", () => {
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });
});

describe("LATENCY_PAGES", () => {
  it("equals the nav hrefs with the map off", () => {
    const hrefs = navGroupsFor("operations", { map: false }).flatMap((g) =>
      g.items.map((i) => i.href),
    );
    expect([...LATENCY_PAGES]).toEqual(hrefs);
    expect(LATENCY_PAGES).not.toContain("/admin/map");
  });
});
