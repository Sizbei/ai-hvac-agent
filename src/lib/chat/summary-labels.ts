/**
 * Pure: customer-facing labels for the chat's request summary (card + confirm
 * dialog). Stored values are enums ("thermostat_issue", "medium"); customers
 * see sentence case and plain words, never the jargon "Medium".
 */

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
