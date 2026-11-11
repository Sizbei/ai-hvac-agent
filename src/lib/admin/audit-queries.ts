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
import { and, eq, gte, inArray, sql, count, desc, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLog, jobTypes, serviceRequests, tagTypes, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { AuditLogEntry, AuditLogFilters, AuditLogPage } from "./audit-types";
import { auditDetailIds } from "./audit-format";
import { SHOW_ALL, VISIBLE_ONLY, visibleRows, visibleRowsSql, type Visibility } from "./visibility";

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

  // Org viewers who don't see hidden history start at the go-live cutoff and
  // skip the sync entries of hidden invoices (the nightly pull re-logs them).
  const baseConditions: SQL[] = [
    ...(filters.since ? [gte(auditLog.createdAt, filters.since)] : []),
    ...(filters.visibleOnly
      ? [
          sql`NOT (${auditLog.action} = 'invoice_synced' AND EXISTS (SELECT 1 FROM invoices i WHERE i.id = ${auditLog.entityId} AND i.organization_id = ${organizationId} AND NOT ${visibleRowsSql("i", VISIBLE_ONLY)}))`,
        ]
      : []),
  ];
  const conditions: SQL[] = [...baseConditions];
  const action = filters.action?.trim();
  if (action) {
    conditions.push(eq(auditLog.action, action));
  }
  const entity = filters.entity?.trim();
  if (entity) {
    conditions.push(eq(auditLog.entity, entity));
  }

  const whereClause = withTenant(auditLog, organizationId, ...conditions);

  // The distinct-actions list is keyed only on the org, the cutoff and the
  // hidden-invoice filter (not the action/entity filters) so the filter
  // dropdown always shows every option, even after one is selected.
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
      // SECURITY (A12, P1): scope the join to the session's org too, not just
      // auditLog.userId = users.id. Some rows (e.g. org_provisioned, written
      // by platform provisioning) have userId pointing at a user in a
      // DIFFERENT org than auditLog.organizationId. An unscoped join would
      // resolve that foreign userId and leak the platform admin's real name
      // into a provisioned org's own audit-log page. Scoping the join means a
      // foreign actor never resolves — actorName comes back null and renders
      // as "System" (existing null-actor UI) — while the row itself, and its
      // organizationId-scoped `details`, stays visible.
      .leftJoin(
        users,
        and(eq(auditLog.userId, users.id), eq(users.organizationId, organizationId)),
      )
      .where(whereClause)
      .orderBy(desc(auditLog.createdAt))
      .limit(limit)
      .offset(offset),

    db
      .selectDistinct({ action: auditLog.action })
      .from(auditLog)
      .where(withTenant(auditLog, organizationId, ...baseConditions))
      .orderBy(sql`${auditLog.action} ASC`),
  ]);

  const refs = await resolveAuditRefs(
    organizationId,
    rows.flatMap((r) => auditDetailIds(r.details)),
    filters.visibleOnly ? VISIBLE_ONLY : SHOW_ALL,
  );

  const entries: readonly AuditLogEntry[] = rows.map((r) => ({
    id: r.id,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    actorName: r.actorName,
    sessionId: r.sessionId,
    details: r.details,
    refs: pickRefs(refs, auditDetailIds(r.details)),
    ipAddress: r.ipAddress,
    createdAt: r.createdAt.toISOString(),
  }));

  return {
    entries,
    total: countResult[0]?.value ?? 0,
    actions: actionRows.map((a) => a.action),
  };
}

function pickRefs(
  all: ReadonlyMap<string, string>,
  ids: readonly string[],
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const label = all.get(id);
    if (label) out[id] = label;
  }
  return out;
}

/**
 * Display labels for the ids in a page of audit details, so the viewer never
 * shows a raw id: staff names, request numbers, tag and job type names. All
 * org-scoped; customer ids are not resolved (their names are PII). Ids that
 * resolve to nothing (a deleted or hidden row) are simply left out by the formatter.
 */
async function resolveAuditRefs(
  organizationId: string,
  rawIds: readonly string[],
  vis: Visibility,
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(rawIds)];
  const labels = new Map<string, string>();
  if (ids.length === 0) return labels;
  const [staff, requests, tags, kinds] = await Promise.all([
    db
      .select({ id: users.id, label: users.name })
      .from(users)
      .where(withTenant(users, organizationId, inArray(users.id, ids))),
    db
      .select({ id: serviceRequests.id, label: serviceRequests.referenceNumber })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          inArray(serviceRequests.id, ids),
          visibleRows(serviceRequests, vis),
        ),
      ),
    db
      .select({ id: tagTypes.id, label: tagTypes.name })
      .from(tagTypes)
      .where(withTenant(tagTypes, organizationId, inArray(tagTypes.id, ids))),
    db
      .select({ id: jobTypes.id, label: jobTypes.name })
      .from(jobTypes)
      .where(withTenant(jobTypes, organizationId, inArray(jobTypes.id, ids))),
  ]);
  for (const row of [...staff, ...requests, ...tags, ...kinds]) {
    if (row.label) labels.set(row.id.toLowerCase(), row.label);
  }
  return labels;
}
