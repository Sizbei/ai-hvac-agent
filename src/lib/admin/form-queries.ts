/**
 * Office form writers and readers (M3d spec §4.1, §5.5, §5.6, §6). Raw SQL,
 * organization_id bound on every table reference. Audits are written by the
 * routes (ids and enums only) and only when something changed.
 */
import { sql, type SQL } from "drizzle-orm";
import { readRows } from "@/lib/admin/invoice-field-writes";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import { officeId } from "@/lib/http/idempotency";
import { FORM_LIMITS, parseStoredFields, questionCount, type FormDefinition, type FormField } from "@/lib/forms/form-schema";
import type { FormValues } from "@/lib/forms/form-values";
import { formAppliesSql, visitCountsSql } from "@/lib/forms/form-gates";
import { decryptValues } from "@/lib/tech/form-writes";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));

export const NAME_INDEX = "forms_org_name_active_unique";

export interface FormRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly fields: readonly FormField[];
  readonly jobTypeIds: readonly string[];
  readonly required: boolean;
  readonly active: boolean;
  readonly version: number;
  readonly updatedAt: string;
}

export interface FormListRow {
  readonly id: string;
  readonly name: string;
  readonly questionCount: number;
  readonly jobTypeIds: readonly string[];
  readonly required: boolean;
  readonly active: boolean;
  readonly version: number;
  readonly updatedAt: string;
  readonly submissionCount: number;
}

const SUBMISSION_COUNT = sql.raw("(SELECT count(*)::int FROM form_submissions s WHERE s.form_id = f.id AND s.organization_id = f.organization_id)");

export async function listForms(org: string): Promise<FormListRow[]> {
  const rows = await readRows(sql`SELECT f.id, f.name, f.fields, f.job_type_ids, f.required, f.active, f.version, f.updated_at, ${SUBMISSION_COUNT} AS submission_count
    FROM forms f WHERE f.organization_id = ${org}::uuid ORDER BY f.active DESC, lower(f.name), f.id`);
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    questionCount: questionCount(parseStoredFields(r.fields) ?? []),
    jobTypeIds: (r.job_type_ids as string[] | null) ?? [],
    required: r.required === true,
    active: r.active === true,
    version: Number(r.version),
    updatedAt: iso(r.updated_at),
    submissionCount: Number(r.submission_count),
  }));
}

function toRecord(r: Row): FormRecord {
  return {
    id: String(r.id),
    name: String(r.name),
    description: r.description == null ? null : String(r.description),
    fields: parseStoredFields(r.fields) ?? [],
    jobTypeIds: (r.job_type_ids as string[] | null) ?? [],
    required: r.required === true,
    active: r.active === true,
    version: Number(r.version),
    updatedAt: iso(r.updated_at),
  };
}

export async function getForm(org: string, id: string): Promise<{ form: FormRecord; submissionCount: number } | null> {
  const [r] = await readRows(sql`SELECT f.*, ${SUBMISSION_COUNT} AS submission_count FROM forms f
    WHERE f.id = ${id}::uuid AND f.organization_id = ${org}::uuid`);
  return r ? { form: toRecord(r), submissionCount: Number(r.submission_count) } : null;
}

/** Every id must be one of the org's job types, archived ones included. */
export async function hasUnknownJobType(org: string, ids: readonly string[]): Promise<boolean> {
  const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
  if (unique.length === 0) return false;
  const [r] = await readRows(sql`SELECT count(*)::int AS n FROM job_types
    WHERE organization_id = ${org}::uuid AND id = ANY(${uuidArraySql(unique)})`);
  return Number(r?.n ?? 0) !== unique.length;
}

export type CreateFormResult =
  | { readonly ok: true; readonly id: string; readonly created: boolean }
  | { readonly ok: false; readonly reason: "limit_reached" | "name_taken" | "unknown_job_type" };

/** First valid Save (spec §4.1): id = officeId("form", org, clientToken); a replay returns the same id. */
export async function createForm(org: string, me: string, clientToken: string, def: FormDefinition): Promise<CreateFormResult> {
  const id = officeId("form", org, clientToken);
  if (await hasUnknownJobType(org, def.jobTypeIds)) return { ok: false, reason: "unknown_job_type" };
  let inserted: Row[];
  try {
    inserted = await readRows(sql`INSERT INTO forms (id, organization_id, name, description, fields, job_type_ids, required, created_by)
      SELECT ${id}::uuid, ${org}::uuid, ${def.name}, ${def.description}::text, ${JSON.stringify(def.fields)}::jsonb,
        ${uuidArraySql(def.jobTypeIds.map((j) => j.toLowerCase()))}, ${def.required}, ${me}::uuid
      WHERE (SELECT count(*) FROM forms WHERE organization_id = ${org}::uuid) < ${FORM_LIMITS.maxForms}
      ON CONFLICT (id) DO NOTHING RETURNING id`);
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return { ok: false, reason: "name_taken" };
    throw error;
  }
  if (inserted.length > 0) return { ok: true, id, created: true };
  const [existing] = await readRows(sql`SELECT id FROM forms WHERE id = ${id}::uuid AND organization_id = ${org}::uuid`);
  return existing ? { ok: true, id, created: false } : { ok: false, reason: "limit_reached" };
}

export interface FormPatch {
  readonly version: number;
  readonly definition?: FormDefinition;
  readonly active?: boolean;
}

export type UpdateFormResult =
  | { readonly ok: true; readonly version: number }
  | { readonly ok: false; readonly reason: "not_found" | "stale" | "name_taken" | "unknown_job_type" };

/** PATCH with a version CAS (spec §4.1): fields replaced whole; archive / restore through `active`. */
export async function updateForm(org: string, id: string, patch: FormPatch): Promise<UpdateFormResult> {
  const d = patch.definition;
  if (d && (await hasUnknownJobType(org, d.jobTypeIds))) return { ok: false, reason: "unknown_job_type" };
  const sets: SQL[] = [sql`version = version + 1`, sql`updated_at = now()`];
  if (d) {
    sets.push(
      sql`name = ${d.name}`,
      sql`description = ${d.description}::text`,
      sql`fields = ${JSON.stringify(d.fields)}::jsonb`,
      sql`job_type_ids = ${uuidArraySql(d.jobTypeIds.map((j) => j.toLowerCase()))}`,
      sql`required = ${d.required}`,
    );
  }
  if (patch.active !== undefined) sets.push(sql`active = ${patch.active}`);
  let rows: Row[];
  try {
    rows = await readRows(sql`UPDATE forms SET ${sql.join(sets, sql`, `)}
      WHERE id = ${id}::uuid AND organization_id = ${org}::uuid AND version = ${patch.version}::int RETURNING version`);
  } catch (error) {
    if (isUniqueViolation(error, NAME_INDEX)) return { ok: false, reason: "name_taken" };
    throw error;
  }
  if (rows[0]) return { ok: true, version: Number(rows[0].version) };
  const [exists] = await readRows(sql`SELECT 1 FROM forms WHERE id = ${id}::uuid AND organization_id = ${org}::uuid`);
  return { ok: false, reason: exists ? "stale" : "not_found" };
}

export type ReopenResult =
  | { readonly ok: true; readonly revision: number; readonly changed: boolean; readonly formId: string; readonly appointmentId: string }
  | { readonly ok: false; readonly reason: "not_found" | "answers_removed" | "stale" };

/** Office reopen (spec §5.5): submitted → draft under a revision CAS. */
export async function reopenSubmission(org: string, rid: string, sid: string, revision: number): Promise<ReopenResult> {
  const [r] = await readRows(sql`UPDATE form_submissions SET status = 'draft', submitted_at = NULL, submitted_by = NULL, submit_key = NULL,
      revision = revision + 1, updated_at = now()
    WHERE id = ${sid}::uuid AND organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid
      AND status = 'submitted' AND erased_at IS NULL AND revision = ${revision}::int
    RETURNING revision, form_id, appointment_id`);
  if (r) return { ok: true, revision: Number(r.revision), changed: true, formId: String(r.form_id), appointmentId: String(r.appointment_id) };
  const [cur] = await readRows(sql`SELECT status, revision, erased_at IS NOT NULL AS erased, form_id, appointment_id FROM form_submissions
    WHERE id = ${sid}::uuid AND organization_id = ${org}::uuid AND service_request_id = ${rid}::uuid`);
  if (!cur) return { ok: false, reason: "not_found" };
  if (cur.erased === true) return { ok: false, reason: "answers_removed" };
  if (cur.status === "draft") {
    return { ok: true, revision: Number(cur.revision), changed: false, formId: String(cur.form_id), appointmentId: String(cur.appointment_id) };
  }
  return { ok: false, reason: "stale" };
}

export interface OfficeSubmission {
  readonly id: string;
  readonly formId: string;
  readonly formName: string;
  readonly formVersion: number;
  readonly appointmentId: string;
  readonly appointmentNumber: number;
  readonly visitState: "live" | "ended";
  readonly status: "draft" | "submitted";
  readonly revision: number;
  readonly erased: boolean;
  readonly unreadable: boolean;
  readonly fields: readonly FormField[];
  readonly values: FormValues | null;
  readonly updatedAt: string;
  readonly updatedByName: string | null;
  readonly submittedAt: string | null;
  readonly submittedByName: string | null;
  readonly visitHasTechnician: boolean;
}

export interface RequestForms {
  readonly submissions: readonly OfficeSubmission[];
  readonly missingRequired: ReadonlyArray<{ readonly formId: string; readonly name: string }>;
}

export function requestSubmissionsSql(org: string, rid: string): SQL {
  return sql`SELECT s.id, s.form_id, s.form_name, s.form_version, s.appointment_id, p.appointment_number,
      (p.cancelled_at IS NULL) AS visit_live, s.status, s.revision, s.erased_at IS NOT NULL AS erased, s.fields, s.values_encrypted,
      s.updated_at, uu.name AS updated_by_name, s.submitted_at, su.name AS submitted_by_name,
      EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.appointment_id = p.id AND a.organization_id = ${org}::uuid
        AND a.status <> 'cancelled'::request_status) AS visit_has_technician
    FROM form_submissions s
    JOIN appointments p ON p.id = s.appointment_id AND p.organization_id = ${org}::uuid
    LEFT JOIN users uu ON uu.id = s.updated_by AND uu.organization_id = ${org}::uuid
    LEFT JOIN users su ON su.id = s.submitted_by AND su.organization_id = ${org}::uuid
    WHERE s.organization_id = ${org}::uuid AND s.service_request_id = ${rid}::uuid
      AND NOT (s.status = 'draft' AND s.erased_at IS NULL AND s.values_encrypted IS NULL)
    ORDER BY p.appointment_number, lower(s.form_name), s.id`;
}

/**
 * Required active forms that apply to the request with no submitted copy on a
 * visit that counts; none on a cancelled request; on a completed one only
 * forms created before it was completed (spec §6).
 */
export function missingRequiredFormsSql(org: string, rid: string): SQL {
  return sql`SELECT f.id, f.name FROM forms f
    JOIN service_requests r ON r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
    WHERE f.organization_id = ${org}::uuid AND f.required AND f.active AND ${formAppliesSql("f", "r")}
      AND r.status <> 'cancelled'::request_status
      AND (r.status <> 'completed'::request_status OR r.completed_at IS NULL OR f.created_at < r.completed_at)
      AND NOT EXISTS (SELECT 1 FROM form_submissions s JOIN appointments p ON p.id = s.appointment_id AND p.organization_id = ${org}::uuid
        WHERE s.organization_id = ${org}::uuid AND s.service_request_id = r.id AND s.form_id = f.id AND s.status = 'submitted'
          AND ${visitCountsSql(org, "p")})
    ORDER BY lower(f.name), f.id`;
}

export function toOfficeSubmission(r: Row): OfficeSubmission {
  const erased = r.erased === true;
  const dec = erased ? null : decryptValues(r.values_encrypted == null ? null : String(r.values_encrypted));
  return {
    id: String(r.id),
    formId: String(r.form_id),
    formName: String(r.form_name),
    formVersion: Number(r.form_version),
    appointmentId: String(r.appointment_id),
    appointmentNumber: Number(r.appointment_number),
    visitState: r.visit_live === true ? "live" : "ended",
    status: r.status === "submitted" ? "submitted" : "draft",
    revision: Number(r.revision),
    erased,
    unreadable: dec === "unreadable",
    fields: parseStoredFields(r.fields) ?? [],
    values: dec === null || dec === "unreadable" ? null : dec,
    updatedAt: iso(r.updated_at),
    updatedByName: r.updated_by_name == null ? null : String(r.updated_by_name),
    submittedAt: isoOrNull(r.submitted_at),
    submittedByName: r.submitted_by_name == null ? null : String(r.submitted_by_name),
    visitHasTechnician: r.visit_has_technician === true,
  };
}

/** Null when the request is not in the org. */
export async function getRequestForms(org: string, rid: string): Promise<RequestForms | null> {
  const [req] = await readRows(sql`SELECT 1 FROM service_requests WHERE id = ${rid}::uuid AND organization_id = ${org}::uuid`);
  if (!req) return null;
  const [subs, missing] = await Promise.all([readRows(requestSubmissionsSql(org, rid)), readRows(missingRequiredFormsSql(org, rid))]);
  return {
    submissions: subs.map(toOfficeSubmission),
    missingRequired: missing.map((m) => ({ formId: String(m.id), name: String(m.name) })),
  };
}
