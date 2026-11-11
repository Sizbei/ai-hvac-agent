/**
 * One home for the office-facing labels of request enums (issue type, job
 * type, urgency) on read surfaces: agenda rows, calendar/dispatch cards,
 * suggestion reasons, the request table. Known codes use the same wording as
 * the New request dialog (create-request.ts); an unknown code (an imported or
 * future value) is humanized, never shown raw. Pure — safe in client code.
 */
import { ISSUE_TYPE_LABELS, JOB_TYPE_LABELS, URGENCY_LABELS } from "@/lib/admin/create-request";

/**
 * "cooling_not_working" -> "Cooling not working". Codes only: it always
 * lowercases, so a value that may be free text goes through `codeOrTextLabel`
 * (which the `humanizeCode` helpers in display-labels and issue-type-label
 * call) instead.
 */
export function humanizeSnake(code: string): string {
  const spaced = code.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : "";
}

/**
 * True for a machine code: lowercase letters/digits joined by _ or -
 * ("water_leak", "tune-up", "boiler"), or an upper-case snake code
 * ("COOLING_NOT_WORKING"). Anything else (spaces, mixed case, punctuation,
 * emoji) is free text, such as a FieldPulse job title.
 */
export function isCodeShaped(value: string): boolean {
  const v = value.trim();
  return /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/.test(v) || /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(v);
}

/**
 * An imported free-text title as the office typed it: whitespace collapsed,
 * capitals, punctuation and dashes kept ("Marlow's Deli W. Main St: PREP TABLE",
 * "ON CALL: TROY 8/10-8/16"). Humanizing it would lowercase proper nouns.
 */
function freeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * THE display rule for a value that may be a code or free text: a code is
 * humanized ("water_leak" -> "Water leak"); free text is shown exactly as
 * typed, apart from collapsed whitespace ("Job for Hollow Creek Community
 * Chapel", "hccc open door classroom"). Every label helper defers to this.
 */
export function codeOrTextLabel(value: string | null | undefined): string {
  if (!value) return "";
  return isCodeShaped(value) ? humanizeSnake(value) : freeText(value);
}

function fromMap(
  map: Readonly<Record<string, string>>,
  code: string | null | undefined,
  fallback: string,
): string {
  if (!code) return fallback;
  if (Object.prototype.hasOwnProperty.call(map, code)) return map[code];
  return codeOrTextLabel(code) || fallback;
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

/** A request's customer name for read surfaces: one implementation, in
 * customer-name-display (blank reads "No name on file", never "Unknown"). */
export { NO_CUSTOMER_NAME, customerNameLabel } from "@/lib/admin/customer-name-display";
