/** Office Forms section copy (M3d spec §7.5). Pure, client-safe; dates in the business timezone. */
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import type { OfficeSubmission } from "@/lib/admin/form-queries";
import { FORM_OFFICE_COPY } from "@/lib/admin/form-route-copy";

const TZ = BUSINESS_BASE_LOCATION.timezone;

export const REOPEN_TITLE = "Reopen this form?";
/** The dialog's description; with the title it reads as spec §7.5's sentence. */
export const REOPEN_COPY = "The technician can change the answers and submit again.";
export const REOPEN_NO_TECH = "No technician is on this visit any more.";
export const REOPEN_STALE = FORM_OFFICE_COPY.REOPEN_STALE;
export const REOPEN_ANSWERS_REMOVED = FORM_OFFICE_COPY.ANSWERS_REMOVED;
export const UNREADABLE = "These answers can't be shown.";

export function visitLabel(s: Pick<OfficeSubmission, "appointmentNumber" | "visitState">): string {
  return `Visit #${s.appointmentNumber}${s.visitState === "ended" ? " · ended" : ""}`;
}

export function submissionChip(s: Pick<OfficeSubmission, "erased" | "unreadable" | "status">): string {
  if (s.erased) return "Answers removed";
  if (s.unreadable) return UNREADABLE;
  return s.status === "submitted" ? "Submitted" : "Draft";
}

const when = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/** "Submitted by Alex Rivera · Nov 7, 2:41 PM" / "Last saved by Sam Lee · Nov 7, 2:30 PM". */
export function whoWhen(s: Pick<OfficeSubmission, "status" | "submittedAt" | "submittedByName" | "updatedAt" | "updatedByName">, timeZone: string = TZ): string {
  if (s.status === "submitted" && s.submittedAt) return `Submitted by ${s.submittedByName ?? "a technician"} · ${when(s.submittedAt, timeZone)}`;
  return `Last saved by ${s.updatedByName ?? "a technician"} · ${when(s.updatedAt, timeZone)}`;
}

/** "Not submitted yet: <name>" on open requests; "Required, not submitted: <name>" (warning tone) on completed ones. */
export function missingLine(name: string, requestStatus: string): { text: string; warning: boolean } {
  return requestStatus === "completed"
    ? { text: `Required, not submitted: ${name}`, warning: true }
    : { text: `Not submitted yet: ${name}`, warning: false };
}

export function reopenDescription(visitHasTechnician: boolean): string {
  return visitHasTechnician ? REOPEN_COPY : `${REOPEN_COPY} ${REOPEN_NO_TECH}`;
}
