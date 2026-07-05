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
  /** Point-in-time aging of currently-open receivables (independent of window). */
  readonly arAging: ArAging;

  // 3. Customer service volume.
  /** Count of service requests created in the window. */
  readonly jobsBooked: MetricTrend;

  // 4. Waiting times.
  /** Avg seconds created → a HUMAN dispatcher assigns the job. The headline. */
  readonly firstResponseHumanSeconds: MetricTrend;
  /** Avg seconds created → auto-dispatch assigns. Muted secondary; current window. */
  readonly firstResponseSystemSeconds: number | null;
}
