/**
 * One home for the office-facing labels of request enums (issue type, job
 * type, urgency) on read surfaces: agenda rows, calendar/dispatch cards,
 * suggestion reasons, the request table. Known codes use the same wording as
 * the New request dialog (create-request.ts); an unknown code (an imported or
 * future value) is humanized, never shown raw. Pure — safe in client code.
 */
import { ISSUE_TYPE_LABELS, JOB_TYPE_LABELS, URGENCY_LABELS } from "@/lib/admin/create-request";

/** "cooling_not_working" -> "Cooling not working". */
export function humanizeCode(code: string): string {
  const spaced = code.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "";
}

function fromMap(
  map: Readonly<Record<string, string>>,
  code: string | null | undefined,
  fallback: string,
): string {
  if (!code) return fallback;
  if (Object.prototype.hasOwnProperty.call(map, code)) return map[code];
  return humanizeCode(code) || fallback;
}

export function issueTypeLabel(code: string | null | undefined): string {
  return fromMap(ISSUE_TYPE_LABELS, code, "Service request");
}

export function jobTypeLabel(code: string | null | undefined): string {
  return fromMap(JOB_TYPE_LABELS, code, "Service call");
}

export function urgencyLabel(code: string | null | undefined): string {
  return fromMap(URGENCY_LABELS, code, "Unknown");
}

/** Mid-sentence form: "Service call" -> "service call"; acronyms keep case ("AC"). */
export function inSentence(label: string): string {
  if (!label) return label;
  const [first, ...rest] = label.split(" ");
  const lowered = /^[A-Z0-9]{2,}$/.test(first) ? first : first.toLowerCase();
  return [lowered, ...rest].join(" ");
}
