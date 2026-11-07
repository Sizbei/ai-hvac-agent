/**
 * The technician form write preamble (M3d spec §6, `techFormPreamble`), in two
 * halves because the visit comes from the body: `techFormFront` (session,
 * same-origin, uuid on the job and the form, rate bucket `form` 30/min or
 * `form-draft` 60/min) runs before the body is read; `formGateFail` (readable
 * job, then the visit, assignment, on-site and erased-customer gates in one
 * read) after the replay checks — the draft route's saveId probe, the submit
 * route's idempotency key (lead ruling 3) plus `findSubmitReplay` inside its
 * keyed run (Task 4 review ruling, spec §5.3). The writers re-check
 * everything inside their batch.
 */
import type { NextRequest, NextResponse } from "next/server";
import type { TechSessionPayload } from "@/lib/auth/tech-config";
import { errorResponse } from "@/lib/api-response";
import { RATE_LIMITS } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation/uuid";
import { readRows } from "@/lib/admin/invoice-field-writes";
import { findReadableJob } from "@/lib/tech/ownership";
import { gateReason, readFormGatesSql, toFormGates } from "@/lib/forms/form-gates";
import { frontGates } from "@/lib/tech/invoice-route-guards";
import { formReasonResponse } from "@/lib/tech/form-errors";
import { selectSubmissionSql, toSubmissionRow, type FormWriteFail, type SubmitResult } from "@/lib/tech/form-writes";

type Front = { ok: true; session: TechSessionPayload } | { ok: false; response: NextResponse };

export async function techFormFront(request: NextRequest, id: string, formId: string, bucket: "form" | "form-draft"): Promise<Front> {
  const front = await frontGates(request, id, bucket, bucket === "form-draft" ? RATE_LIMITS.techFormDraft : RATE_LIMITS.adminMutation);
  if (!front.ok) return front;
  if (!isUuid(formId)) return { ok: false, response: errorResponse("Invalid form ID format", "INVALID_ID", 400) };
  return front;
}

/** The gates as a write refusal (null = pass). An unreadable job is NOT_FOUND. */
export async function formGateFail(
  session: TechSessionPayload, id: string, formId: string, rawAppointmentId: string,
): Promise<FormWriteFail | null> {
  const { organizationId: org, userId: me } = session;
  if (!(await findReadableJob(org, me, id))) return { ok: false, reason: "not_found" };
  const aid = rawAppointmentId.toLowerCase(); // Postgres returns lowercase uuids (resolveTarget's rule)
  const g = toFormGates((await readRows(readFormGatesSql(org, id, aid, me, formId.toLowerCase())))[0]);
  const reason = gateReason(g);
  return reason ? { ok: false, reason } : null;
}

export async function techFormGate(
  session: TechSessionPayload, id: string, formId: string, rawAppointmentId: string,
): Promise<{ ok: true } | { ok: false; response: NextResponse }> {
  const fail = await formGateFail(session, id, formId, rawAppointmentId);
  if (!fail) return { ok: true };
  if (fail.reason === "not_found") return { ok: false, response: errorResponse("This job isn't yours.", "NOT_FOUND", 404) };
  return { ok: false, response: formReasonResponse(fail) };
}

/**
 * Spec §5.3 takeover: a re-run of a submit that already committed (the row is
 * submitted with THIS derived key) answers the writer's 200, checked BEFORE the
 * gates so a visit that ended or a job cancelled since can't turn it into an
 * unstored refusal. Read by the natural key (org, request, visit, form); the
 * key is derived from the caller's own idempotency scope, so a match proves
 * the caller sent it. An erased row is not replayed (the gates decide).
 */
export async function findSubmitReplay(
  session: TechSessionPayload, id: string, formId: string, rawAppointmentId: string, submitKey: string,
): Promise<Extract<SubmitResult, { ok: true }> | null> {
  const [pre] = await readRows(selectSubmissionSql(
    session.organizationId, id.toLowerCase(), rawAppointmentId.toLowerCase(), formId.toLowerCase(),
  ));
  const row = toSubmissionRow(pre);
  if (!row || row.erased || row.status !== "submitted" || row.submitKey !== submitKey.toLowerCase() || row.submittedAt === null) return null;
  return { ok: true, submissionId: row.id, revision: row.revision, submittedAt: row.submittedAt };
}
