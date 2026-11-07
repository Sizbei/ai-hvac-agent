/**
 * The raw statements M3d adds to the erase batch (spec §4.5, §5.4). Pure: drizzle
 * `sql` only, organization_id bound on every table reference.
 */
import { sql, type SQL } from "drizzle-orm";
import { uuidArraySql } from "@/lib/db/sql-arrays";

/** Statement 0: lock every request of the customer (request → rows, the writers' order). */
export function eraseLockSql(org: string, cust: string): SQL {
  return sql`SELECT 1 FROM service_requests WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid ORDER BY id FOR NO KEY UPDATE`;
}

const customerRequestIds = (org: string, cust: string): SQL =>
  sql`SELECT id FROM service_requests WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid`;

/**
 * The customer's attachments: their own (office uploads), chat uploads in their
 * sessions, files on their requests (technician photos and PDFs, office request
 * documents) and files on their equipment. Parenthesised: it holds ORs.
 * The request and equipment arms bind organization_id in their subqueries; the
 * customer_id and session_id arms do NOT. Every caller must AND this with
 * `attachments.organization_id = $org` (eraseAuditSql and eraseAttachmentsSql do).
 */
export function attachmentMatchSql(org: string, cust: string, sessionIds: readonly string[]): SQL {
  return sql`(customer_id = ${cust}::uuid
    OR session_id = ANY(${uuidArraySql(sessionIds)})
    OR service_request_id IN (${customerRequestIds(org, cust)})
    OR equipment_id IN (SELECT id FROM customer_equipment WHERE organization_id = ${org}::uuid AND customer_id = ${cust}::uuid))`;
}

/** Statement 1: the audit row, counting the attachments in SQL (ids and counts only). */
export function eraseAuditSql(org: string, cust: string, sessionIds: readonly string[]): SQL {
  return sql`INSERT INTO audit_log (organization_id, user_id, action, entity, entity_id, details)
    VALUES (${org}::uuid, NULL, 'customer_erased', 'customers', ${cust}::uuid,
      json_build_object('sessions', ${sessionIds.length}::int,
        'attachmentsDeleted', (SELECT count(*)::int FROM attachments WHERE organization_id = ${org}::uuid AND ${attachmentMatchSql(org, cust, sessionIds)}))::text)`;
}

/** Statement 2: delete them, handing their storage keys to the after() cleanup. */
export function eraseAttachmentsSql(org: string, cust: string, sessionIds: readonly string[]): SQL {
  return sql`DELETE FROM attachments WHERE organization_id = ${org}::uuid AND ${attachmentMatchSql(org, cust, sessionIds)} RETURNING storage_key`;
}

/** Last statement: answers on the customer's requests go; status, who and when stay. */
export function eraseAnswersSql(org: string, cust: string): SQL {
  return sql`UPDATE form_submissions SET values_encrypted = NULL, erased_at = COALESCE(erased_at, now()), updated_at = now()
    WHERE organization_id = ${org}::uuid AND service_request_id IN (${customerRequestIds(org, cust)})`;
}
