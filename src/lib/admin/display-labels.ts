/**
 * Human labels for the codes admin pages show (issue types, note types,
 * equipment types). One map per code family so the drawer, the profile and the
 * form dialogs never render "water_leak" or "follow_up". Sentence case per the
 * copy canon. Pure — safe for client components and plain vitest.
 */
import { codeOrTextLabel, issueTypeLabel } from "@/lib/admin/request-labels";

export interface LabeledOption {
  readonly value: string;
  readonly label: string;
}

/** "follow_up" → "Follow up"; free text (a FieldPulse job title) as typed.
 * The one shared rule lives in request-labels (`codeOrTextLabel`). */
export function humanizeCode(code: string | null | undefined): string {
  return codeOrTextLabel(code);
}

/** Request issue type ("water_leak" → "Water leak"); same helper as the
 * requests, calendar and dispatch surfaces. */
export { issueTypeLabel };

function labelFrom(
  labels: Readonly<Record<string, string>>,
  code: string | null | undefined,
  fallback: string,
): string {
  if (!code) return fallback;
  return labels[code] ?? (humanizeCode(code) || fallback);
}

export const NOTE_TYPE_OPTIONS: readonly LabeledOption[] = [
  { value: "general", label: "General" },
  { value: "follow_up", label: "Follow up" },
  { value: "complaint", label: "Complaint" },
  { value: "compliment", label: "Compliment" },
];

export const EQUIPMENT_TYPE_OPTIONS: readonly LabeledOption[] = [
  { value: "ac", label: "Air conditioner" },
  { value: "furnace", label: "Furnace" },
  { value: "heat_pump", label: "Heat pump" },
  { value: "boiler", label: "Boiler" },
  { value: "mini_split", label: "Mini split" },
  { value: "thermostat", label: "Thermostat" },
  { value: "other", label: "Other" },
];

const toMap = (options: readonly LabeledOption[]): Record<string, string> =>
  Object.fromEntries(options.map((o) => [o.value, o.label]));

const NOTE_TYPE_LABELS = toMap(NOTE_TYPE_OPTIONS);
const EQUIPMENT_TYPE_LABELS = toMap(EQUIPMENT_TYPE_OPTIONS);

export function noteTypeLabel(code: string | null | undefined): string {
  return labelFrom(NOTE_TYPE_LABELS, code, "General");
}

export function equipmentTypeLabel(code: string | null | undefined): string {
  return labelFrom(EQUIPMENT_TYPE_LABELS, code, "Other");
}
