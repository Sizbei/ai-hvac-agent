/** Technician form copy and small decisions (M3d spec §7.2–§7.4, §8). Pure, client-safe. */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import type { WriteBlockedReason } from "@/lib/forms/form-gates";
import { plural } from "@/lib/format/plural";
import { MAY_NOT_HAVE_SAVED } from "@/lib/tech/estimate-intents";
import type { CardForm } from "@/lib/tech/form-view";

const TZ = BUSINESS_BASE_LOCATION.timezone;

const dayKey = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const time = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(d);
const monthDay = (d: Date, timeZone: string) => new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(d);

/** "2:41 PM" today, "Nov 6, 2:41 PM" earlier (business timezone). */
export function whenShort(iso: string, now: Date, timeZone: string = TZ): string {
  const d = new Date(iso);
  return dayKey(d, timeZone) === dayKey(now, timeZone) ? time(d, timeZone) : `${monthDay(d, timeZone)}, ${time(d, timeZone)}`;
}

export const READ_ONLY_COPY: Record<Exclude<WriteBlockedReason, "submitted">, string> = {
  not_assigned: "Only a technician on this visit can fill in its forms.",
  visit_ended: "This visit has ended.",
  not_on_site: "Arrive at the job first.",
  job_closed: "This job is closed.",
  archived: "This form was archived by the office.",
  answers_removed: "These answers were removed.",
  customer_removed: "This job's customer was removed.",
  unreadable: "These answers can't be shown.",
};
export const ASSIGN_AGAIN = "Ask the office to assign you to this job again.";

/** The read-only lines for a reason (`submitted` shows in the status line only). */
export function readOnlyCopy(reason: WriteBlockedReason | null, opts: { readonly myRowCancelled: boolean }): string[] {
  if (reason === null || reason === "submitted") return [];
  const lines = [READ_ONLY_COPY[reason]];
  if (reason === "not_assigned" && opts.myRowCancelled) lines.push(ASSIGN_AGAIN);
  return lines;
}

export type StatusPhase =
  | "blank" | "saved" | "saving" | "retrying" | "signed_out" | "too_large" | "bad_request" | "blocked"
  | "submit_sent" | "submit_unknown" | "submitted";

export interface StatusInput {
  readonly phase: StatusPhase;
  readonly savedAt: string | null;
  /** First name of whoever saved last, when it wasn't me. */
  readonly savedByOther: string | null;
  readonly unparsedCount: number;
  readonly submittedAt: string | null;
  readonly submittedByName: string | null;
  readonly now: Date;
}

export const SIGNED_OUT = "You've been signed out. Sign in again, then open this job again.";
export const TOO_LONG = "This form is too long to save. Shorten the longest answers.";
export const COULDNT_SAVE = "Couldn't save your answers.";
export const RETRYING = "Not saved yet. Retrying…";

/** The status line (spec §7.3 table). Never `Saved` while a number is unparsed. */
export function statusLine(i: StatusInput, timeZone: string = TZ): string {
  switch (i.phase) {
    case "submitted":
      return ["Submitted", i.submittedAt ? whenFull(i.submittedAt, timeZone) : null, i.submittedByName].filter(Boolean).join(" · ");
    case "submit_sent":
      return "Submitting…";
    case "submit_unknown":
      return MAY_NOT_HAVE_SAVED;
    case "signed_out":
      return SIGNED_OUT;
    case "too_large":
      return TOO_LONG;
    case "bad_request":
      return COULDNT_SAVE;
    case "blocked":
      return "";
    default:
      break;
  }
  if (i.unparsedCount > 0) {
    return `Not saved yet: ${plural(i.unparsedCount, "answer isn't a number.", "answers aren't numbers.")}`;
  }
  if (i.phase === "retrying") return RETRYING;
  if (i.phase === "saving") return "Saving…";
  if (i.phase === "saved" && i.savedAt) {
    const by = i.savedByOther ? ` · ${i.savedByOther}` : "";
    return `Saved · ${whenShort(i.savedAt, i.now, timeZone)}${by}`;
  }
  return "";
}

/** "Nov 6" (the "Submitted on visit #1 · Nov 6" line, whatever the time). */
export function dayShort(iso: string, timeZone: string = TZ): string {
  return monthDay(new Date(iso), timeZone);
}

/** "Nov 7, 2:41 PM" always (the submitted line). */
export function whenFull(iso: string, timeZone: string = TZ): string {
  const d = new Date(iso);
  return `${monthDay(d, timeZone)}, ${time(d, timeZone)}`;
}

export const firstName = (name: string | null): string | null => (name ? name.trim().split(/\s+/)[0] ?? null : null);

/** The number input's note under it (spec §7.3). */
export function numberNote(kind: "empty" | "partial" | "invalid" | "out_of_bounds" | "value"): string | null {
  if (kind === "partial") return "Not saved yet. Finish the number.";
  if (kind === "invalid") return "Enter a number like 12.5 (up to 3 decimal places).";
  if (kind === "out_of_bounds") return "Enter a number under 1,000,000.";
  return null;
}

/** The card's chips, in precedence (spec §7.2). */
export function formChips(f: CardForm): { readonly status: string; readonly required: boolean } {
  const s = f.submission;
  let status: string;
  if (s?.erased) status = "Answers removed";
  else if (s?.status === "submitted") status = "Submitted";
  else if (f.submittedOn) status = `Submitted on visit #${f.submittedOn.appointmentNumber}`;
  else status = s?.hasAnswers ? "Draft" : "Not started";
  return { status, required: f.required };
}

/** The card's visit: `?visit=`, else my assignment's visit, else the job's active visit. */
export function cardVisit(param: string | undefined, assignmentVisitId: string | null, activeVisitId: string | null): string | null {
  return param ?? assignmentVisitId ?? activeVisitId ?? null;
}

/** The fill page's back link (spec §7.3). */
export function backHref(p: { jobId: string; formId: string; visitId: string; myVisit: boolean; from: string | null }): { label: string; href: string } {
  if (p.from) return { label: "Back", href: `/tech/jobs/${p.jobId}/forms/${p.formId}?visit=${p.from}` };
  return { label: "Back to job", href: p.myVisit ? `/tech/jobs/${p.jobId}?visit=${p.visitId}` : `/tech/jobs/${p.jobId}` };
}

export const fillHref = (jobId: string, formId: string, visitId: string, from?: string): string =>
  `/tech/jobs/${jobId}/forms/${formId}?visit=${visitId}${from ? `&from=${from}` : ""}`;

/** The close-out sheet shows "Not submitted yet:" for close out on native jobs, blocked or ready (spec §7.4). */
export function reminderVisible(action: string | null, native: boolean, reminders: readonly unknown[]): boolean {
  return action === "close_out" && native && reminders.length > 0;
}

export const missingRequiredLine = (n: number): string =>
  n === 1 ? "1 required question isn't answered." : `${n} required questions aren't answered.`;

export const SUBMITTED_BY_OTHER = (name: string): string => `${name} submitted this form. Your last changes weren't saved.`;
export const FOREIGN_CHANGE = "Someone else changed this form. Their answers are shown, and yours are kept.";
export const SUBMITTED_ON = (n: number, day: string): string => `Submitted on visit #${n} · ${day}. Fill it in again only if this visit needs it.`;
