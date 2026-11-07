/**
 * Record a technician's job photo or PDF (M3d spec §5.4). ONE batch: L_req,
 * then an INSERT … SELECT that re-checks the read rule and refuses a request
 * whose customer was erased. Lives apart from field-queries.ts because it
 * needs `runBatch` / `lockRequestSql`, and invoice-field-writes.ts already
 * imports field-queries.ts.
 */
import { sql, type SQL } from "drizzle-orm";
import { lockRequestSql, readRows, runBatch } from "@/lib/admin/invoice-field-writes";
import { techCanReadSql } from "@/lib/tech/ownership";

export interface JobPhotoInput {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly storageKey: string;
}

export type AddJobPhotoResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: "not_owned" | "customer_removed" | "stale" };

const NOT_ERASED = (org: string): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM customers c WHERE c.id = service_requests.customer_id AND c.organization_id = ${org}::uuid AND c.anonymized_at IS NOT NULL)`;

export function jobPhotoInsertSql(org: string, me: string, rid: string, input: JobPhotoInput): SQL {
  return sql`INSERT INTO attachments (organization_id, service_request_id, filename, mime_type, size, storage_key)
    SELECT ${org}::uuid, service_requests.id, ${input.filename}, ${input.mimeType}, ${input.size}::int, ${input.storageKey}
    FROM service_requests
    WHERE service_requests.id = ${rid}::uuid AND service_requests.organization_id = ${org}::uuid
      AND ${techCanReadSql(org, me)} AND ${NOT_ERASED(org)}
    RETURNING id`;
}

export async function addJobPhoto(org: string, me: string, rid: string, input: JobPhotoInput): Promise<AddJobPhotoResult> {
  const out = await runBatch([lockRequestSql(org, rid), jobPhotoInsertSql(org, me, rid, input)]);
  // A failed batch (deadlock) is retryable, never "not yours" (equipment-writes does the same).
  if (!Array.isArray(out)) return { ok: false, reason: "stale" };
  if (out[1]![0]) return { ok: true, id: String(out[1]![0].id) };
  // Nothing written: say why (the route deletes the uploaded object either way).
  const [r] = await readRows(sql`SELECT ${NOT_ERASED(org)} AS live FROM service_requests
    WHERE service_requests.id = ${rid}::uuid AND service_requests.organization_id = ${org}::uuid AND ${techCanReadSql(org, me)}`);
  return { ok: false, reason: r && r.live === false ? "customer_removed" : "not_owned" };
}
