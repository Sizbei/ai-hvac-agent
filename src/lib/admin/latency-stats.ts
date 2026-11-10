import { navGroupsFor } from "../../components/admin/nav-items";

/** Nav hrefs measured by scripts/agent/measure-latency.mjs (map gated off). */
export const LATENCY_PAGES: readonly string[] = navGroupsFor("operations", {
  map: false,
}).flatMap((g) => g.items.map((i) => i.href));

/** Nearest-rank percentile; NaN for an empty sample. Input is not mutated. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

function ms(samples: readonly number[], p: number): string {
  const v = percentile(samples, p);
  return Number.isNaN(v) ? "-" : String(Math.round(v));
}

export interface LatencyRow {
  readonly path: string;
  readonly frame: number[];
  readonly firstRow: number[];
}

/** One aligned row per path: frame and first-row p50/p90 in milliseconds. */
export function formatLatencyTable(rows: readonly LatencyRow[]): string {
  const header = ["path", "frame p50", "frame p90", "row p50", "row p90"];
  const body = rows.map((r) => [
    r.path,
    ms(r.frame, 50),
    ms(r.frame, 90),
    ms(r.firstRow, 50),
    ms(r.firstRow, 90),
  ]);
  const all = [header, ...body];
  const widths = header.map((_, c) => Math.max(...all.map((row) => row[c].length)));
  return all
    .map((row) =>
      row.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join("  "),
    )
    .join("\n");
}
