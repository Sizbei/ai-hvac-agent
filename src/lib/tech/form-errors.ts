/** Reason → HTTP status / code / copy / details for the technician form writes (M3d spec §4.3, §8). */
import type { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api-response";
import type { RunResult } from "@/lib/http/idempotency";
import type { FormWriteFail, FormWriteReason } from "@/lib/tech/form-writes";

type Shape = { status: number; code: string; message: string };

export const FORM_REASON: Record<FormWriteReason, Shape> = {
  not_found: { status: 404, code: "NOT_FOUND", message: "This form is no longer on this job." },
  job_not_found: { status: 404, code: "NOT_FOUND", message: "This job isn't yours." },
  job_closed: { status: 409, code: "JOB_CLOSED", message: "This job is closed." },
  visit_ended: { status: 409, code: "VISIT_ENDED", message: "This visit has ended." },
  not_assigned: { status: 403, code: "NOT_ASSIGNED", message: "Only a technician on this visit can fill in its forms." },
  not_on_site: { status: 409, code: "NOT_ON_SITE", message: "Arrive at the job first." },
  customer_removed: { status: 409, code: "CUSTOMER_REMOVED", message: "This job's customer was removed." },
  form_archived: { status: 409, code: "FORM_ARCHIVED", message: "This form was archived by the office." },
  form_changed: { status: 409, code: "FORM_CHANGED", message: "The office changed this form. Check your answers." },
  answers_removed: { status: 409, code: "ANSWERS_REMOVED", message: "These answers were removed." },
  form_submitted: { status: 409, code: "FORM_SUBMITTED", message: "This form was already submitted." },
  answers_unreadable: { status: 409, code: "ANSWERS_UNREADABLE", message: "These answers can't be shown." },
  stale: { status: 409, code: "STALE", message: "Someone else changed this form." },
  invalid_values: { status: 400, code: "INVALID_INPUT", message: "Couldn't save your answers." },
  values_too_large: { status: 400, code: "INVALID_INPUT", message: "This form is too long to save. Shorten the longest answers." },
  form_incomplete: { status: 400, code: "FORM_INCOMPLETE", message: "Answer the required questions." },
};

/** Details are ids, a revision or a path only (spec §3.3), never zod text or answers. */
export function formReasonDetails(f: FormWriteFail): Record<string, unknown> | undefined {
  if (f.reason === "values_too_large") return { path: ["values"] };
  if (f.fieldIds) return { fieldIds: [...f.fieldIds] };
  if (f.reason === "stale") return { revision: f.revision ?? 0 };
  return undefined;
}

export function formReasonResult(f: FormWriteFail): RunResult {
  const { status, code, message } = FORM_REASON[f.reason];
  const details = formReasonDetails(f);
  return { status, envelope: { success: false, error: details ? { message, code, details } : { message, code } } };
}

export function formReasonResponse(f: FormWriteFail): NextResponse {
  const { status, code, message } = FORM_REASON[f.reason];
  return errorResponse(message, code, status, formReasonDetails(f));
}
