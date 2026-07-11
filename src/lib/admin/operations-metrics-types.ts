/**
 * Operations metrics — the owner's daily-glance operational scorecard.
 *
 * Distinct from reporting-queries (money: revenue, AR balances, close rate) and
 * ops-insights (all-time request breakdowns). THIS is the time/flow layer:
 * how fast we reach customers, how long jobs take, how quickly we get paid, and
 * how much work came in — each over a selectable window, with a period-over-
 * period trend.
 *
 * UNITS: every duration field is in SECONDS (the page formats adaptively into
 * s / min / hrs / days). Money is in CENTS. Counts are raw integers.
 */

/**
 * A headline value with its immediately-preceding equal-length window, so the
 * page can render the delta arrow. `null` = no qualifying data in that window
 * (rendered as "—", never a misleading 0).
 */
export interface MetricTrend {
  readonly current: number | null;
  readonly previous: number | null;
}

/** Outstanding balance on open (sent, unpaid) invoices, bucketed by invoice age. */
export interface ArAging {
  readonly bucket0to30Cents: number;
  readonly bucket31to60Cents: number;
  readonly bucket60PlusCents: number;
  readonly totalOutstandingCents: number;
}

/** Outstanding balance on SYNCED (FP/HCP) open invoices, bucketed by days past
 * the source system's due date. `currentCents` = not yet due. */
export interface SyncedArAging {
  readonly currentCents: number;
  readonly overdue1to30Cents: number;
  readonly overdue31to60Cents: number;
  readonly overdue60PlusCents: number;
  readonly totalOutstandingCents: number;
}

export interface OperationsMetrics {
  /** The selected window, in days — echoed back for the page header/labels. */
  readonly rangeDays: number;

  // 1. Technician time to job.
  /** Median seconds from request created → tech starts work (first in_progress). */
  readonly responseTimeSeconds: MetricTrend;
  /** Avg seconds on site (clock-in → clock-out). Secondary line; current window. */
  readonly onSiteSeconds: number | null;

  // 2. AR days for invoicing.
  /** Avg seconds from native invoice created → paid. Synced FP/HCP excluded. */
  readonly timeToPaidSeconds: MetricTrend;
  /**
   * Point-in-time aging of NATIVE open receivables (independent of window).
   * FieldPulse-synced and HCP-synced open invoices are excluded from these
   * buckets — they are managed in their respective source systems.
   */
  readonly arAging: ArAging;
  /** Total outstanding cents across FP-synced open invoices (for summary line). */
  readonly syncedArTotalCents: number;
  /** Count of FP-synced open invoices in the AR summary. */
  readonly syncedArCount: number;
  /**
   * Point-in-time aging of SYNCED (FP/HCP) open receivables, bucketed by the
   * source system's due date (days PAST DUE; `current` = not yet due). Rows
   * without a due date fall back to issue age. Money stays owned by the source
   * system — these buckets are visibility, not collections triggers.
   */
  readonly syncedArAging: SyncedArAging;

  // 3. Customer service volume.
  /**
   * Count of NATIVE service requests created in the window (FP/HCP-imported
   * excluded — they were already booked in the source system).
   */
  readonly jobsBooked: MetricTrend;
  /**
   * Count of FP-imported service requests in the current window.
   * Shown as "+N imported" suffix next to the native jobsBooked.
   */
  readonly importedJobsCurrent: number;

  // 4. Waiting times.
  /** Avg seconds created → a HUMAN dispatcher assigns the job. The headline. */
  readonly firstResponseHumanSeconds: MetricTrend;
  /** Avg seconds created → auto-dispatch assigns. Muted secondary; current window. */
  readonly firstResponseSystemSeconds: number | null;
}
