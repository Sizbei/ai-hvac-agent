/**
 * "Is this sold estimate billed?" (M3c spec §5.3) as SQL, shared by the field
 * bill, the office Generate guard, the office "Sold, not invoiced" filter and
 * the technician GET. Pure: drizzle `sql` only.
 *
 * billed(eid) = the OFFICE half (a non-void invoice with estimate_id = eid) OR
 * the JOB half (a non-void native invoice not born from an estimate holding a
 * line linked to one of the sold option's lines). `eid` is a uuid-typed SQL
 * expression: `eidParam(id)` or a column. Aliases are unique per builder so a
 * builder can sit inside a query that already uses e / i / x.
 */
import { sql, type SQL } from "drizzle-orm";

/** `('arrived'::request_status, …)` for a constant status list. */
export function statusInSql(statuses: readonly string[]): SQL {
  return sql.raw(`(${statuses.map((s) => `'${s}'::request_status`).join(", ")})`);
}

export const eidParam = (id: string): SQL => sql`${id}::uuid`;

export function officeBilledSql(org: string, eid: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM invoices obi WHERE obi.organization_id = ${org}::uuid AND obi.estimate_id = ${eid} AND obi.state <> 'void'::invoice_state)`;
}

/** The sold option's line ids. */
function soldLineIdsSql(org: string, eid: SQL): SQL {
  return sql`SELECT jbl.id FROM estimate_line_items jbl JOIN estimates jbe ON jbe.sold_option_id = jbl.option_id
    WHERE jbe.id = ${eid} AND jbe.organization_id = ${org}::uuid AND jbl.organization_id = ${org}::uuid`;
}

const jobLinesFrom = (org: string, eid: SQL): SQL =>
  sql`FROM invoice_line_items jbx JOIN invoices jbi ON jbi.id = jbx.invoice_id
    WHERE jbx.organization_id = ${org}::uuid AND jbi.organization_id = ${org}::uuid AND jbi.estimate_id IS NULL
      AND jbi.state <> 'void'::invoice_state AND jbi.fieldpulse_invoice_id IS NULL AND jbi.hcp_invoice_id IS NULL
      AND jbx.estimate_line_item_id IN (${soldLineIdsSql(org, eid)})`;

export function jobBilledSql(org: string, eid: SQL): SQL {
  return sql`EXISTS (SELECT 1 ${jobLinesFrom(org, eid)})`;
}

export function billedSql(org: string, eid: SQL): SQL {
  return sql`(${officeBilledSql(org, eid)} OR ${jobBilledSql(org, eid)})`;
}

/** The invoice that bills it: the newest non-void office invoice, else the newest job invoice holding its lines. */
export function billingInvoiceIdSql(org: string, eid: SQL): SQL {
  return sql`COALESCE(
    (SELECT obi.id FROM invoices obi WHERE obi.organization_id = ${org}::uuid AND obi.estimate_id = ${eid} AND obi.state <> 'void'::invoice_state ORDER BY obi.created_at DESC LIMIT 1),
    (SELECT jbi.id ${jobLinesFrom(org, eid)} ORDER BY jbi.created_at DESC LIMIT 1))`;
}
