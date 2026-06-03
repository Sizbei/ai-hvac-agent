/**
 * Admin "Operations Insights" dashboard types.
 *
 * Where AI Insights covers the chat funnel (deflection, conversion, tokens),
 * THIS covers the dispatch operation: what kinds of jobs come in, how urgent,
 * their lifecycle status, and how work is distributed across technicians.
 *
 * All metrics are derived from EXISTING tables (service_requests, users) — no
 * schema change. All properties are readonly.
 */

/** A labelled count for a category breakdown (issue type, urgency, status). */
export interface CategoryCount {
  readonly key: string;
  readonly count: number;
}

/** Per-technician request load. `technicianId` is null for the "unassigned"
 * bucket (requests with no assignee yet). */
export interface TechnicianLoad {
  readonly technicianId: string | null;
  readonly technicianName: string | null;
  readonly total: number;
  /** Currently open (pending/assigned/in_progress) — the actionable backlog. */
  readonly active: number;
  readonly completed: number;
}

/** Number of requests created in a given hour-of-day bucket (0–23, UTC — the
 * Neon session default). Surfaces peak demand windows; apply the org's local
 * offset for local interpretation. */
export interface HourlyCount {
  /** Hour of day, 0–23 (UTC). */
  readonly hour: number;
  readonly count: number;
}

/** Aggregate cost stats over recorded service-history entries. Costs are stored
 * as integer CENTS; the values here are also cents (the UI divides by 100). */
export interface CostStats {
  /** Number of service-history rows that carry a (non-null) cost. */
  readonly count: number;
  /** Sum of all recorded costs, in cents. */
  readonly totalCents: number;
  /** Mean cost across rows that carry a cost, in cents (0 when count is 0). */
  readonly averageCents: number;
}

export interface OpsInsights {
  readonly totalRequests: number;
  /** Open = not completed and not cancelled. */
  readonly openRequests: number;
  readonly completedRequests: number;
  readonly cancelledRequests: number;
  /** Requests created in the last 7 days. */
  readonly requestsLast7Days: number;
  readonly byIssueType: readonly CategoryCount[];
  readonly byUrgency: readonly CategoryCount[];
  readonly byStatus: readonly CategoryCount[];
  readonly technicianLoad: readonly TechnicianLoad[];
  /** Request volume by hour of day (always 24 entries, hour 0–23). */
  readonly requestsByHour: readonly HourlyCount[];
  /** Recorded service-cost aggregates (cents). */
  readonly costStats: CostStats;
}
