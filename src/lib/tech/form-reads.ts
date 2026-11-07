/**
 * Technician form GETs (M3d spec §6): the visit's forms for the job page card,
 * and one form for the fill page. Read rule = findReadableJob; the visit must
 * belong to the request and count (spec §5.1), else not_found.
 */
import { sql, type SQL } from "drizzle-orm";
import { readRows } from "@/lib/admin/invoice-field-writes";
import { findReadableJob } from "@/lib/tech/ownership";
import { parseStoredFields } from "@/lib/forms/form-schema";
import {
  formAppliesSql, readFormGatesSql, toFormGates, visitCountsSql, writeBlockedReason, type FormGates,
} from "@/lib/forms/form-gates";
import { decryptValues } from "@/lib/tech/form-writes";
import { buildFormsCard, type SubmissionRowIn, type SubmittedOn, type TechFormsView, type TechFormView } from "@/lib/tech/form-view";

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

export function countingVisitSql(org: string, rid: string, aid: string): SQL {
  return sql`SELECT p.id, p.appointment_number, ${visitCountsSql(org, "p")} AS counts FROM appointments p
    WHERE p.id = ${aid}::uuid AND p.service_request_id = ${rid}::uuid AND p.organization_id = ${org}::uuid`;
}

export function cardFormsSql(org: string, rid: string): SQL {
  return sql`SELECT f.id, f.name, f.description, f.required, f.active, ${formAppliesSql("f", "r")} AS applies
    FROM forms f JOIN service_requests r ON r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
    WHERE f.organization_id = ${org}::uuid ORDER BY lower(f.name), f.id`;
}

export function cardSubmissionsSql(org: string, rid: string): SQL {
  return sql`SELECT s.id, s.form_id, s.appointment_id, p.appointment_number, s.status, s.revision,
      s.values_encrypted IS NOT NULL AS has_answers, s.erased_at IS NOT NULL AS erased, s.updated_at, s.submitted_at,
      su.name AS submitted_by_name, ${visitCountsSql(org, "p")} AS visit_counts
    FROM form_submissions s
    JOIN appointments p ON p.id = s.appointment_id AND p.organization_id = ${org}::uuid
    LEFT JOIN users su ON su.id = s.submitted_by AND su.organization_id = ${org}::uuid
    WHERE s.organization_id = ${org}::uuid AND s.service_request_id = ${rid}::uuid`;
}

function toSubmissionIn(r: Row): SubmissionRowIn {
  return {
    id: String(r.id),
    formId: String(r.form_id),
    appointmentId: String(r.appointment_id),
    appointmentNumber: Number(r.appointment_number),
    status: r.status === "submitted" ? "submitted" : "draft",
    revision: Number(r.revision),
    hasAnswers: r.has_answers === true,
    erased: r.erased === true,
    updatedAt: iso(r.updated_at),
    submittedAt: isoOrNull(r.submitted_at),
    submittedByName: strOrNull(r.submitted_by_name),
    visitCounts: r.visit_counts === true,
  };
}

type Visit = { id: string; number: number; gates: FormGates };

/** Readable job → the visit counts → the gate row. Null = 404. */
async function openVisit(org: string, me: string, rid: string, aid: string, formId: string | null): Promise<Visit | null> {
  if (!(await findReadableJob(org, me, rid))) return null;
  const [v] = await readRows(countingVisitSql(org, rid, aid));
  if (!v || v.counts !== true) return null;
  const gates = toFormGates((await readRows(readFormGatesSql(org, rid, aid, me, formId)))[0]);
  return gates ? { id: String(v.id), number: Number(v.appointment_number), gates } : null;
}

export type FormsResult = { kind: "not_found" } | { kind: "ok"; view: TechFormsView };

export async function getJobForms(org: string, me: string, rid: string, rawAid: string): Promise<FormsResult> {
  const aid = rawAid.toLowerCase();
  const visit = await openVisit(org, me, rid, aid, null);
  if (!visit) return { kind: "not_found" };
  const [forms, subs] = await Promise.all([readRows(cardFormsSql(org, rid)), readRows(cardSubmissionsSql(org, rid))]);
  const card = buildFormsCard(
    visit.id,
    forms.map((f) => ({
      id: String(f.id), name: String(f.name), description: strOrNull(f.description),
      required: f.required === true, active: f.active === true, applies: f.applies === true,
    })),
    subs.map(toSubmissionIn),
  );
  // Visit-level reason: a form with no row on an active form (archived is per form).
  const reason = writeBlockedReason({ ...visit.gates, formActive: true }, null);
  return {
    kind: "ok",
    view: {
      visitId: visit.id, visitNumber: visit.number, myVisit: visit.gates.myRow, canWrite: reason === null,
      writeBlockedReason: reason, myRowCancelled: visit.gates.myRow && !visit.gates.myLiveRow, ...card,
    },
  };
}

export function oneSubmissionSql(org: string, rid: string, aid: string, formId: string): SQL {
  return sql`SELECT s.id, s.status, s.revision, s.erased_at IS NOT NULL AS erased, s.form_name, s.form_version, s.fields, s.values_encrypted,
      s.updated_at, s.updated_by, uu.name AS updated_by_name, s.submitted_at, su.name AS submitted_by_name
    FROM form_submissions s
    LEFT JOIN users uu ON uu.id = s.updated_by AND uu.organization_id = ${org}::uuid
    LEFT JOIN users su ON su.id = s.submitted_by AND su.organization_id = ${org}::uuid
    WHERE s.organization_id = ${org}::uuid AND s.appointment_id = ${aid}::uuid AND s.form_id = ${formId}::uuid AND s.service_request_id = ${rid}::uuid`;
}

export function submittedElsewhereSql(org: string, rid: string, aid: string, formId: string): SQL {
  return sql`SELECT s.appointment_id, p.appointment_number, s.submitted_at FROM form_submissions s
    JOIN appointments p ON p.id = s.appointment_id AND p.organization_id = ${org}::uuid
    WHERE s.organization_id = ${org}::uuid AND s.service_request_id = ${rid}::uuid AND s.form_id = ${formId}::uuid
      AND s.status = 'submitted' AND s.appointment_id <> ${aid}::uuid AND ${visitCountsSql(org, "p")}
    ORDER BY s.submitted_at DESC LIMIT 1`;
}

export type FormResult = { kind: "not_found" } | { kind: "archived" } | { kind: "ok"; view: TechFormView };

export async function getJobForm(org: string, me: string, rid: string, rawFormId: string, rawAid: string): Promise<FormResult> {
  const aid = rawAid.toLowerCase();
  const formId = rawFormId.toLowerCase();
  const visit = await openVisit(org, me, rid, aid, formId);
  if (!visit) return { kind: "not_found" };
  const [[form], [row]] = await Promise.all([
    readRows(sql`SELECT name, description, version, fields, active FROM forms WHERE id = ${formId}::uuid AND organization_id = ${org}::uuid`),
    readRows(oneSubmissionSql(org, rid, aid, formId)),
  ]);
  if (!form) return { kind: "not_found" };
  if (!row && form.active !== true) return { kind: "archived" };

  const erased = row?.erased === true;
  const dec = row && !erased ? decryptValues(strOrNull(row.values_encrypted)) : null;
  const unreadable = dec === "unreadable";
  const status = row?.status === "submitted" ? "submitted" : "draft";
  let submittedOn: SubmittedOn | null = null;
  if (status !== "submitted" || !row) {
    const [o] = await readRows(submittedElsewhereSql(org, rid, aid, formId));
    if (o) submittedOn = { appointmentId: String(o.appointment_id), appointmentNumber: Number(o.appointment_number), submittedAt: iso(o.submitted_at) };
  }
  const reason = writeBlockedReason(visit.gates, row ? { status, erased, unreadable } : null);
  const fields = parseStoredFields(row ? row.fields : form.fields) ?? [];
  return {
    kind: "ok",
    view: {
      form: {
        name: String(row ? row.form_name : form.name),
        description: strOrNull(form.description),
        version: Number(row ? row.form_version : form.version),
        fields,
      },
      submission: row
        ? {
            id: String(row.id), status, revision: Number(row.revision),
            values: dec === null || dec === "unreadable" ? null : dec,
            updatedAt: iso(row.updated_at), updatedByName: strOrNull(row.updated_by_name),
            updatedByMe: String(row.updated_by ?? "") === me.toLowerCase(),
            submittedAt: isoOrNull(row.submitted_at), submittedByName: strOrNull(row.submitted_by_name), erased,
          }
        : null,
      submittedOn,
      myVisit: visit.gates.myRow,
      canWrite: reason === null,
      writeBlockedReason: reason,
      myRowCancelled: visit.gates.myRow && !visit.gates.myLiveRow,
    },
  };
}
