/**
 * Read-side queries for the admin audit-log viewer.
 *
 * The audit log is the non-repudiation record for every state-changing admin
 * action (and safety-critical customer events like emergency escalation). This
 * surfaces it, paginated and tenant-scoped, with the actor's name joined in.
 *
 * Every query is tenant-scoped via withTenant (multi-tenancy contract). The
 * `details` column only ever holds field NAMES / ids (never decrypted PII), so
 * it is safe to return verbatim.
 */
import { eq, sql, count, desc, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { AuditLogEntry, AuditLogFilters, AuditLogPage } from "./audit-types";

const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export async function getAuditLog(
  organizationId: string,
  filters: AuditLogFilters,
): Promise<AuditLogPage> {
  const page = Math.max(1, filters.page ?? DEFAULT_PAGE);
  const limit = Math.min(MAX_LIMIT, Math.max(1, filters.limit ?? DEFAULT_LIMIT));
  const offset = (page - 1) * limit;

  const conditions: SQL[] = [];
  const action = filters.action?.trim();
  if (action) {
    conditions.push(eq(auditLog.action, action));
  }
  const entity = filters.entity?.trim();
  if (entity) {
    conditions.push(eq(auditLog.entity, entity));
  }

  const whereClause = withTenant(auditLog, organizationId, ...conditions);

  // The distinct-actions list is keyed only on the org (not the action/entity
  // filters) so the filter dropdown always shows every option, even after one
  // is selected.
  const [countResult, rows, actionRows] = await Promise.all([
    db
      .select({ value: count() })
      .from(auditLog)
      .where(whereClause),

    db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        sessionId: auditLog.sessionId,
        details: auditLog.details,
        ipAddress: auditLog.ipAddress,
        createdAt: auditLog.createdAt,
        actorName: users.name,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.userId, users.id))
      .where(whereClause)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .offset(offset),

    db
      .selectDistinct({ action: auditLog.action })
      .from(auditLog)
      .where(withTenant(auditLog, organizationId))
      .orderBy(sql`${auditLog.action} ASC`),
  ]);

  const entries: readonly AuditLogEntry[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    actorName: r.actorName,
    sessionId: r.sessionId,
    details: r.details,
    ipAddress: r.ipAddress,
    createdAt: r.createdAt.toISOString(),
  }));

  return {
    entries,
    total: countResult[0]?.value ?? 0,
    actions: actionRows.map((a) => a.action),
  };
}
