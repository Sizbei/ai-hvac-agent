/**
 * The ONE definition of "open requests" shared by the dashboard tiles and the
 * AI insights Operations section:
 *
 *   open = status in OPEN_STATUSES (pending, scheduled, assigned, en_route,
 *          arrived, in_progress, on_hold), from every source.
 *
 * The dashboard splits it by status into five native tiles, each with a
 * "+N imported" suffix for FieldPulse / Housecall Pro jobs; insights shows the
 * same total in one tile. Native + imported on the dashboard = the insights
 * number. The requests page filters by the same statuses, all sources.
 */
import type { DashboardStats } from "./types";

export interface OpenRequestTotals {
  /** Booked in this app (no FieldPulse / Housecall Pro id). */
  readonly native: number;
  readonly imported: number;
  readonly total: number;
}

export function openRequestTotals(stats: DashboardStats): OpenRequestTotals {
  const native =
    stats.pending + stats.scheduled + stats.assigned + stats.inProgress + stats.onHold;
  const imported =
    stats.importedPending +
    stats.importedScheduled +
    stats.importedAssigned +
    stats.importedInProgress +
    stats.importedOnHold;
  return { native, imported, total: native + imported };
}

/** "+N imported" suffix for a tile, or undefined when there are none. */
export function importedSuffix(n: number): string | undefined {
  return n > 0 ? `+${n} imported` : undefined;
}

/** One-line caption over the dashboard tiles. */
export function openRequestCaption(t: OpenRequestTotals): string {
  const noun = t.total === 1 ? "open request" : "open requests";
  return t.imported > 0
    ? `${t.total} ${noun}: ${t.native} booked here, ${t.imported} imported from FieldPulse or Housecall Pro`
    : `${t.total} ${noun}`;
}
