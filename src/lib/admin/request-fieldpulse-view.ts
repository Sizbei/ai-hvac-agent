/**
 * What the request sheet shows from a FieldPulse-imported job's extra data.
 * Pure, so the hide/show rules are unit-tested.
 *
 * - Metrics: a $0 total is FieldPulse's "nothing billed on the job", not a
 *   price, so it is not shown; zero or missing times are not shown either.
 * - Details: `tags` holds bare FieldPulse tag ids ("498516, 498095") with no
 *   names to resolve, so it is dropped; `is_multiday_job` becomes a
 *   "Multi-day" badge when true and is dropped otherwise.
 */
import { formatCentsExact } from "@/lib/admin/money-format";
import { humanizeSeconds } from "@/lib/admin/duration-format";

export interface FieldpulseMetricsInput {
  readonly statusLogSeconds: {
    readonly on_the_way: number | null;
    readonly in_progress: number | null;
  };
  readonly totalPriceCents: number | null;
}

export interface MetricRow {
  readonly label: string;
  readonly value: string;
}

export function fieldpulseMetricRows(metrics: FieldpulseMetricsInput | null | undefined): MetricRow[] {
  if (!metrics) return [];
  const rows: MetricRow[] = [];
  const total = metrics.totalPriceCents;
  if (total != null && Number.isFinite(total) && total > 0) {
    rows.push({ label: "Total price", value: formatCentsExact(total) });
  }
  const times: readonly [string, number | null][] = [
    ["Time on the way", metrics.statusLogSeconds?.on_the_way ?? null],
    ["Time in progress", metrics.statusLogSeconds?.in_progress ?? null],
  ];
  for (const [label, seconds] of times) {
    const value = seconds != null && seconds > 0 ? humanizeSeconds(seconds) : null;
    if (value) rows.push({ label, value });
  }
  return rows;
}

const DROPPED_KEYS = new Set(["tags", "is_multiday_job"]);

export interface FieldpulseExtras {
  /** What is left for the FieldPulse details panel; null when nothing is. */
  readonly details: Record<string, unknown> | null;
  readonly multiDay: boolean;
}

export function requestFieldpulseExtras(data: Record<string, unknown> | null | undefined): FieldpulseExtras {
  if (!data || typeof data !== "object") return { details: null, multiDay: false };
  const rest = Object.fromEntries(Object.entries(data).filter(([key]) => !DROPPED_KEYS.has(key)));
  return {
    details: Object.keys(rest).length > 0 ? rest : null,
    multiDay: data.is_multiday_job === true,
  };
}
