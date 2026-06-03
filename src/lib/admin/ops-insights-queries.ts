/**
 * Database queries for the admin "Operations Insights" dashboard.
 *
 * Every metric is computed from EXISTING tables (service_requests, users) via
 * GROUP BY aggregates — no metrics table, no schema change. Each query is
 * tenant-scoped via withTenant (multi-tenancy contract).
 *
 * NOTE: the neon-http driver returns SQL aggregates (count) as strings, so each
 * aggregate value is coerced with Number() before use.
 */
import { eq, and, sql, count, gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests, serviceHistory, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type {
  OpsInsights,
  CategoryCount,
  TechnicianLoad,
  HourlyCount,
  CostStats,
} from "./ops-insights-types";

function toNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Statuses that count as "open" (actionable backlog). */
const OPEN_STATUSES = ["pending", "assigned", "in_progress"] as const;

export async function getOpsInsights(
  organizationId: string,
): Promise<OpsInsights> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Grouped breakdowns and the per-tech load run independently; gather them
  // concurrently. Each is org-scoped via withTenant.
  const [
    issueRows,
    urgencyRows,
    statusRows,
    last7Row,
    techRows,
    hourRows,
    costRow,
  ] = await Promise.all([
    db
      .select({ key: serviceRequests.issueType, value: count() })
      .from(serviceRequests)
      .where(withTenant(serviceRequests, organizationId))
      .groupBy(serviceRequests.issueType),

    db
      .select({ key: serviceRequests.urgency, value: count() })
      .from(serviceRequests)
      .where(withTenant(serviceRequests, organizationId))
      .groupBy(serviceRequests.urgency),

    db
      .select({ key: serviceRequests.status, value: count() })
      .from(serviceRequests)
      .where(withTenant(serviceRequests, organizationId))
      .groupBy(serviceRequests.status),

    db
      .select({ value: count() })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          gte(serviceRequests.createdAt, sevenDaysAgo),
        ),
      ),

    // Per-technician load: total, active (open statuses), completed. Grouped by
    // assignee (NULL = unassigned bucket), left-joined to users for the name.
    db
      .select({
        technicianId: serviceRequests.assignedTo,
        technicianName: users.name,
        total: count(),
        active: sql<number | string>`count(*) filter (where ${serviceRequests.status} in ('pending','assigned','in_progress'))`,
        completed: sql<number | string>`count(*) filter (where ${serviceRequests.status} = 'completed')`,
      })
      .from(serviceRequests)
      // Scope the join to the SAME org too — defense in depth so a request whose
      // assignedTo somehow points at another tenant's user (app-layer bug / data
      // drift) can never leak that user's name onto this org's dashboard.
      .leftJoin(
        users,
        and(
          eq(serviceRequests.assignedTo, users.id),
          eq(users.organizationId, organizationId),
        ),
      )
      .where(withTenant(serviceRequests, organizationId))
      .groupBy(serviceRequests.assignedTo, users.name),

    // Request volume by hour of day. extract(hour from ...) returns 0–23 in the
    // session timezone — which on Neon defaults to UTC, so these are UTC hours
    // (the UI labels them as such). Hours with no requests are simply absent and
    // are backfilled to 0 below. The ::int is a Postgres-side normalisation;
    // neon-http still returns it as a string over the wire, so toNumber() (in
    // the mapping) does the real coercion.
    db
      .select({
        hour: sql<number | string>`extract(hour from ${serviceRequests.createdAt})::int`,
        value: count(),
      })
      .from(serviceRequests)
      .where(withTenant(serviceRequests, organizationId))
      .groupBy(sql`extract(hour from ${serviceRequests.createdAt})`),

    // Service-cost aggregates over recorded history rows that carry a cost.
    // count()/sum()/avg() come back as strings on neon-http → coerced below.
    db
      .select({
        count: sql<number | string>`count(${serviceHistory.cost})`,
        total: sql<number | string>`coalesce(sum(${serviceHistory.cost}), 0)`,
        average: sql<number | string>`coalesce(avg(${serviceHistory.cost}), 0)`,
      })
      .from(serviceHistory)
      .where(withTenant(serviceHistory, organizationId)),
  ]);

  const byIssueType: CategoryCount[] = issueRows
    .map((r) => ({ key: r.key, count: toNumber(r.value) }))
    .sort((a, b) => b.count - a.count);

  const byUrgency: CategoryCount[] = urgencyRows.map((r) => ({
    key: r.key,
    count: toNumber(r.value),
  }));

  const byStatus: CategoryCount[] = statusRows.map((r) => ({
    key: r.key,
    count: toNumber(r.value),
  }));

  const technicianLoad: TechnicianLoad[] = techRows
    .map((r) => ({
      technicianId: r.technicianId,
      technicianName: r.technicianName,
      total: toNumber(r.total),
      active: toNumber(r.active),
      completed: toNumber(r.completed),
    }))
    // Heaviest active load first; unassigned bucket naturally sorts by its load.
    .sort((a, b) => b.active - a.active || b.total - a.total);

  // Backfill the 24-hour histogram so every hour 0–23 is present (absent hours
  // → 0), giving the UI a dense, predictable array to render.
  const hourCounts = new Map<number, number>(
    hourRows.map((r) => [toNumber(r.hour), toNumber(r.value)]),
  );
  const requestsByHour: HourlyCount[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    count: hourCounts.get(hour) ?? 0,
  }));

  const costCountValue = toNumber(costRow[0]?.count);
  const costStats: CostStats = {
    count: costCountValue,
    totalCents: toNumber(costRow[0]?.total),
    // avg() already excludes NULLs; round to whole cents and guard the 0-row case.
    averageCents: costCountValue > 0 ? Math.round(toNumber(costRow[0]?.average)) : 0,
  };

  // Derive the headline totals from the status breakdown so we don't re-query.
  const statusMap = new Map(byStatus.map((s) => [s.key, s.count]));
  const totalRequests = byStatus.reduce((sum, s) => sum + s.count, 0);
  const completedRequests = statusMap.get("completed") ?? 0;
  const cancelledRequests = statusMap.get("cancelled") ?? 0;
  const openRequests = OPEN_STATUSES.reduce(
    (sum, s) => sum + (statusMap.get(s) ?? 0),
    0,
  );

  return {
    totalRequests,
    openRequests,
    completedRequests,
    cancelledRequests,
    requestsLast7Days: toNumber(last7Row[0]?.value),
    byIssueType,
    byUrgency,
    byStatus,
    technicianLoad,
    requestsByHour,
    costStats,
  };
}
