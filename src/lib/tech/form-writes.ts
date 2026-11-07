/**
 * Technician form writes (M3d spec §5.2–§5.3). Draft = changes applied to the
 * decrypted document under a revision gate, replayed by `saveId` (checked
 * first, before any decrypt). Submit = the same batch, keyed by the route's
 * idempotency key, with an in-batch audit gated on the row THIS transaction
 * submitted. Each write is ONE db.batch led by L_req; every statement repeats
 * the request and visit gates; outcomes come from the batch's tail SELECT.
 */
import { sql, type SQL } from "drizzle-orm";
import { lockRequestSql, readRows, runBatch } from "@/lib/admin/invoice-field-writes";
import { decrypt, encrypt } from "@/lib/crypto";
import { parseStoredFields, type FormField } from "@/lib/forms/form-schema";
import { applyChanges, missingRequired, valuesTooLarge, type Changes, type FormValues } from "@/lib/forms/form-values";
import {
  gateReason, readFormGatesSql, requestGateSql, toFormGates, visitGateSql, type FormGates, type GateReason,
} from "@/lib/forms/form-gates";

export type FormWriteReason =
  | GateReason
  | "form_archived" | "form_changed" | "answers_removed" | "form_submitted" | "answers_unreadable"
  | "stale" | "invalid_values" | "values_too_large" | "form_incomplete";

export interface FormWriteFail {
  readonly ok: false;
  readonly reason: FormWriteReason;
  readonly fieldIds?: readonly string[];
  readonly revision?: number;
}

export interface FormActor { readonly organizationId: string; readonly requestId: string; readonly techUserId: string }

export interface DraftInput {
  readonly formId: string;
  readonly appointmentId: string;
  readonly formVersion: number;
  readonly baseRevision: number;
  readonly saveId: string;
  readonly changes: Changes;
}
export type SubmitInput = Omit<DraftInput, "saveId">;

export type DraftResult =
  | { readonly ok: true; readonly submissionId: string; readonly revision: number; readonly savedAt: string; readonly created: boolean }
  | FormWriteFail;
export type SubmitResult =
  | { readonly ok: true; readonly submissionId: string; readonly revision: number; readonly submittedAt: string }
  | FormWriteFail;

type Row = Record<string, unknown>;
const fail = (reason: FormWriteReason, extra: { fieldIds?: readonly string[]; revision?: number } = {}): FormWriteFail =>
  ({ ok: false, reason, ...extra });
const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const lc = (s: string): string => s.toLowerCase();

/** The submission row by its natural key, every column the decisions read. */
export interface SubmissionRow {
  readonly id: string;
  readonly status: "draft" | "submitted";
  readonly revision: number;
  readonly formVersion: number;
  readonly erased: boolean;
  readonly lastSaveId: string | null;
  readonly submitKey: string | null;
  readonly updatedAt: string;
  readonly submittedAt: string | null;
  readonly fields: unknown;
  readonly valuesEncrypted: string | null;
}

export function toSubmissionRow(r: Row | undefined): SubmissionRow | null {
  if (!r) return null;
  return {
    id: String(r.id),
    status: r.status === "submitted" ? "submitted" : "draft",
    revision: Number(r.revision),
    formVersion: Number(r.form_version),
    erased: r.erased === true,
    lastSaveId: r.last_save_id == null ? null : String(r.last_save_id),
    submitKey: r.submit_key == null ? null : String(r.submit_key),
    updatedAt: iso(r.updated_at),
    submittedAt: r.submitted_at == null ? null : iso(r.submitted_at),
    fields: r.fields ?? null,
    valuesEncrypted: r.values_encrypted == null ? null : String(r.values_encrypted),
  };
}

const ROW_COLUMNS = sql.raw(
  "id, status, revision, form_version, erased_at IS NOT NULL AS erased, last_save_id, submit_key, updated_at, submitted_at, fields, values_encrypted",
);

function naturalKeySql(org: string, rid: string, aid: string, form: string): SQL {
  return sql`organization_id = ${org}::uuid AND appointment_id = ${aid}::uuid AND form_id = ${form}::uuid AND service_request_id = ${rid}::uuid`;
}

export function selectSubmissionSql(org: string, rid: string, aid: string, form: string): SQL {
  return sql`SELECT ${ROW_COLUMNS} FROM form_submissions WHERE ${naturalKeySql(org, rid, aid, form)}`;
}

/** Decrypt a stored document. null blob = no answers; a blob that won't decrypt or parse = "unreadable". */
export function decryptValues(enc: string | null): FormValues | "unreadable" {
  if (enc === null) return {};
  try {
    const parsed: unknown = JSON.parse(decrypt(enc));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
    return parsed as FormValues;
  } catch {
    return "unreadable";
  }
}

/** The empty document stores NULL (spec §3.2: NULL = no answers). */
export const encryptValues = (values: FormValues): string | null =>
  Object.keys(values).length === 0 ? null : encrypt(JSON.stringify(values));

/** First statement of the batch after L_req: create the row from the live form at `formVersion` (spec §5.2 step 1). */
export function insertSubmissionSql(a: FormActor, input: { formId: string; appointmentId: string; formVersion: number }): SQL {
  const { organizationId: org, requestId: rid, techUserId: me } = a;
  const aid = input.appointmentId;
  return sql`INSERT INTO form_submissions (organization_id, form_id, service_request_id, appointment_id, form_name, form_version, fields, started_by)
    SELECT ${org}::uuid, f.id, ${rid}::uuid, ${aid}::uuid, f.name, f.version, f.fields, ${me}::uuid FROM forms f
    WHERE f.id = ${input.formId}::uuid AND f.organization_id = ${org}::uuid AND f.active AND f.version = ${input.formVersion}::int
      AND ${requestGateSql(org, rid, aid, me)} AND ${visitGateSql(org, rid, aid, me)}
    ON CONFLICT (appointment_id, form_id, service_request_id) DO NOTHING RETURNING id`;
}

/** The gated UPDATE (spec §5.2 step 2); `set` adds the submit columns. */
export function updateSubmissionSql(a: FormActor, input: SubmitInput, enc: string | null, set: SQL): SQL {
  const { organizationId: org, requestId: rid, techUserId: me } = a;
  const aid = input.appointmentId;
  return sql`UPDATE form_submissions SET values_encrypted = ${enc}::text, revision = revision + 1, updated_by = ${me}::uuid, updated_at = now()${set}
    WHERE ${naturalKeySql(org, rid, aid, input.formId)} AND status = 'draft' AND erased_at IS NULL
      AND revision = ${input.baseRevision}::int AND form_version = ${input.formVersion}::int
      AND ${requestGateSql(org, rid, aid, me)} AND ${visitGateSql(org, rid, aid, me)}
    RETURNING id, revision, updated_at, submitted_at`;
}

/** Step 2b: audit only a row THIS transaction submitted with THIS key (spec §5.3). */
export function submitAuditSql(a: FormActor, input: SubmitInput, submitKey: string): SQL {
  const { organizationId: org, requestId: rid, techUserId: me } = a;
  return sql`INSERT INTO audit_log (organization_id, user_id, action, entity, entity_id, details)
    SELECT s.organization_id, ${me}::uuid, 'form_submitted', 'form_submissions', s.id,
      json_build_object('formId', s.form_id, 'appointmentId', s.appointment_id, 'formVersion', s.form_version)::text
    FROM form_submissions s
    WHERE s.organization_id = ${org}::uuid AND s.appointment_id = ${input.appointmentId}::uuid AND s.form_id = ${input.formId}::uuid
      AND s.service_request_id = ${rid}::uuid AND s.status = 'submitted' AND s.submit_key = ${submitKey}::uuid
      AND s.xmin = pg_current_xact_id()::xid`;
}

export type ZeroRow = { kind: "replay" } | { kind: "fail"; fail: FormWriteFail };

/**
 * The batch's UPDATE matched nothing (spec §5.2 "Zero rows from 2"): our own
 * landed write (save id, or this submit key) → replay; else the first refusal.
 */
export function zeroRowOutcome(
  tail: SubmissionRow | null,
  g: FormGates | null,
  input: { formVersion: number; baseRevision: number; saveId?: string; submitKey?: string },
): ZeroRow {
  if (tail && input.saveId !== undefined && tail.revision === input.baseRevision + 1 && tail.lastSaveId === lc(input.saveId)) {
    return { kind: "replay" };
  }
  if (tail && input.submitKey !== undefined && tail.status === "submitted" && tail.submitKey === lc(input.submitKey)) {
    return { kind: "replay" };
  }
  const gate = gateReason(g);
  if (!tail) {
    if (gate) return { kind: "fail", fail: fail(gate) };
    if (!g!.formFound) return { kind: "fail", fail: fail("not_found") };
    if (!g!.formActive) return { kind: "fail", fail: fail("form_archived") };
    if (g!.formVersion !== input.formVersion) return { kind: "fail", fail: fail("form_changed") };
    return { kind: "fail", fail: fail("stale", { revision: 0 }) };
  }
  if (tail.erased) return { kind: "fail", fail: fail("answers_removed") };
  if (tail.status === "submitted") return { kind: "fail", fail: fail("form_submitted") };
  if (tail.formVersion !== input.formVersion) return { kind: "fail", fail: fail("form_changed") };
  if (gate) return { kind: "fail", fail: fail(gate) };
  return { kind: "fail", fail: fail("stale", { revision: tail.revision }) };
}

type Prepared = { ok: true; values: FormValues; fields: readonly FormField[] } | FormWriteFail;

/** Pre-read decisions (spec §5.2 steps 2–3), then apply the changes. */
async function prepare(a: FormActor, input: SubmitInput, row: SubmissionRow | null): Promise<Prepared> {
  let fields: readonly FormField[] | null;
  let doc: FormValues;
  if (row) {
    if (row.erased) return fail("answers_removed");
    if (row.status === "submitted") return fail("form_submitted");
    if (row.formVersion !== input.formVersion) return fail("form_changed");
    // Spec §4.2 "the document it changed is the one it read": refuse a base other than the pre-read revision.
    if (row.revision !== input.baseRevision) return fail("stale", { revision: row.revision });
    const dec = decryptValues(row.valuesEncrypted);
    fields = parseStoredFields(row.fields);
    if (dec === "unreadable" || fields === null) return fail("answers_unreadable");
    doc = dec;
  } else {
    // No row yet: only revision 0 can be the base (a later base is a client that read a row since removed).
    if (input.baseRevision !== 0) return fail("stale", { revision: 0 });
    const [form] = await readRows(sql`SELECT active, version, fields FROM forms
      WHERE id = ${input.formId}::uuid AND organization_id = ${a.organizationId}::uuid`);
    if (!form) return fail("not_found");
    if (form.active !== true) return fail("form_archived");
    if (Number(form.version) !== input.formVersion) return fail("form_changed");
    fields = parseStoredFields(form.fields);
    if (fields === null) return fail("answers_unreadable");
    doc = {};
  }
  const applied = applyChanges(fields, doc, input.changes);
  if (!applied.ok) return fail("invalid_values", { fieldIds: applied.fieldIds });
  if (valuesTooLarge(applied.values)) return fail("values_too_large");
  return { ok: true, values: applied.values, fields };
}

async function readGates(a: FormActor, input: SubmitInput): Promise<FormGates | null> {
  const [g] = await readRows(readFormGatesSql(a.organizationId, a.requestId, input.appointmentId, a.techUserId, input.formId));
  return toFormGates(g);
}

const normDraft = (raw: DraftInput): DraftInput =>
  ({ ...raw, appointmentId: lc(raw.appointmentId), formId: lc(raw.formId), saveId: lc(raw.saveId) });

function replayOf(row: SubmissionRow | null, input: DraftInput): DraftResult | null {
  return row && row.revision === input.baseRevision + 1 && row.lastSaveId === input.saveId
    ? { ok: true, submissionId: row.id, revision: row.revision, savedAt: row.updatedAt, created: false }
    : null;
}

/**
 * The replay probe the draft route runs BEFORE its gates (spec §4.2: "the replay
 * check runs first"): a retry of a write that landed answers 200 even after the
 * visit ended or the job closed. The saveId is a client-minted uuid, so a match
 * proves the caller sent the write.
 */
export async function findDraftReplay(a: FormActor, raw: DraftInput): Promise<DraftResult | null> {
  const input = normDraft(raw);
  const [pre] = await readRows(selectSubmissionSql(a.organizationId, a.requestId, input.appointmentId, input.formId));
  return replayOf(toSubmissionRow(pre), input);
}

export async function saveFormDraft(a: FormActor, raw: DraftInput): Promise<DraftResult> {
  const input = normDraft(raw);
  const { organizationId: org, requestId: rid } = a;
  const [pre] = await readRows(selectSubmissionSql(org, rid, input.appointmentId, input.formId));
  const row = toSubmissionRow(pre);
  // 1. Replay first: nothing else is read, decrypted, applied or measured.
  const replay = replayOf(row, input);
  if (replay) return replay;
  const prepared = await prepare(a, input, row);
  if (!prepared.ok) return prepared;
  const enc = encryptValues(prepared.values);

  const out = await runBatch([
    lockRequestSql(org, rid),
    insertSubmissionSql(a, input),
    updateSubmissionSql(a, input, enc, sql`, last_save_id = ${input.saveId}::uuid`),
    selectSubmissionSql(org, rid, input.appointmentId, input.formId),
  ]);
  if (!Array.isArray(out)) return fail("stale", { revision: row?.revision ?? 0 });
  const [, inserted, updated, tailRows] = out;
  const up = updated![0];
  if (up) {
    return { ok: true, submissionId: String(up.id), revision: Number(up.revision), savedAt: iso(up.updated_at), created: inserted!.length > 0 };
  }
  const tail = toSubmissionRow(tailRows![0]);
  const z = zeroRowOutcome(tail, await readGates(a, input), input);
  if (z.kind === "replay") return { ok: true, submissionId: tail!.id, revision: tail!.revision, savedAt: tail!.updatedAt, created: false };
  return z.fail;
}

export async function submitForm(a: FormActor, raw: SubmitInput, ids: { submitKey: string }): Promise<SubmitResult> {
  const input = { ...raw, appointmentId: lc(raw.appointmentId), formId: lc(raw.formId) };
  const submitKey = lc(ids.submitKey);
  const { organizationId: org, requestId: rid, techUserId: me } = a;
  const [pre] = await readRows(selectSubmissionSql(org, rid, input.appointmentId, input.formId));
  const row = toSubmissionRow(pre);
  // A takeover re-run of a submit that already committed (its audit committed with it).
  if (row && row.status === "submitted" && row.submitKey === submitKey) {
    return { ok: true, submissionId: row.id, revision: row.revision, submittedAt: row.submittedAt! };
  }
  const prepared = await prepare(a, input, row);
  if (!prepared.ok) return prepared;
  const missing = missingRequired(prepared.fields, prepared.values);
  if (missing.length > 0) return fail("form_incomplete", { fieldIds: missing });
  const enc = encryptValues(prepared.values);

  const out = await runBatch([
    lockRequestSql(org, rid),
    insertSubmissionSql(a, input),
    updateSubmissionSql(a, input, enc,
      sql`, status = 'submitted', submitted_by = ${me}::uuid, submitted_at = now(), submit_key = ${submitKey}::uuid`),
    submitAuditSql(a, input, submitKey),
    selectSubmissionSql(org, rid, input.appointmentId, input.formId),
  ]);
  if (!Array.isArray(out)) return fail("stale", { revision: row?.revision ?? 0 });
  const [, , updated, , tailRows] = out;
  const up = updated![0];
  if (up) return { ok: true, submissionId: String(up.id), revision: Number(up.revision), submittedAt: iso(up.submitted_at) };
  const tail = toSubmissionRow(tailRows![0]);
  const z = zeroRowOutcome(tail, await readGates(a, input), { formVersion: input.formVersion, baseRevision: input.baseRevision, submitKey });
  if (z.kind === "replay") return { ok: true, submissionId: tail!.id, revision: tail!.revision, submittedAt: tail!.submittedAt! };
  return z.fail;
}
