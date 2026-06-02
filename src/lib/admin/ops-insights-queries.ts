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
import { serviceRequests, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type {
  OpsInsights,
  CategoryCount,
  TechnicianLoad,
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
  };
}
