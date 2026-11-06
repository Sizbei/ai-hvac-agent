/**
 * Pure: customer-facing labels for the chat's request summary (card + confirm
 * dialog). Stored values are enums ("thermostat_issue", "medium"); customers
 * see sentence case and plain words, never the jargon "Medium".
 */
import { issueTypeValues } from "@/lib/ai/extraction-schema";

const URGENCY_LABEL: Readonly<Record<string, string>> = {
  low: "Can wait",
  medium: "Soon",
  high: "Urgent",
  emergency: "Emergency",
};

export function urgencyLabel(value: string): string {
  return URGENCY_LABEL[value] ?? sentenceCase(value);
}

/** "thermostat_issue" → "Thermostat issue"; keeps acronyms like HVAC/AC. */
export function sentenceCase(value: string): string {
  const words = value.replace(/_/g, " ").trim().split(/\s+/).filter(Boolean);
  return words
    .map((w, i) => {
      if (/^[A-Z0-9]{2,}$/.test(w)) return w; // acronym
      const lower = w.toLowerCase();
      if (lower === "hvac" || lower === "ac") return lower.toUpperCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** Issue-type choices for the summary card's Edit (value = stored enum). */
export const ISSUE_TYPE_OPTIONS: readonly { readonly value: string; readonly label: string }[] =
  issueTypeValues.map((value) => ({ value, label: sentenceCase(value) }));

/**
 * One-line summary for the collapsed card on phones:
 * "Cooling not working · Urgent · 12 Oak St". Missing parts are skipped.
 */
export function compactSummary(fields: {
  readonly issueType?: string | null;
  readonly urgency?: string | null;
  readonly address?: string | null;
}): string {
  const street = fields.address?.split(",")[0]?.trim();
  return [
    fields.issueType ? sentenceCase(fields.issueType) : null,
    fields.urgency ? urgencyLabel(fields.urgency) : null,
    street || null,
  ]
    .filter((p): p is string => Boolean(p))
    .join(" · ");
}
