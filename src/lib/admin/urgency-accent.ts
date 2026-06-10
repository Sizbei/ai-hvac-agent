/**
 * Urgency → calendar accent classes. Derived from the same palette as
 * urgency-badge.tsx so calendar cards/chips read consistently with the badges.
 *
 * `bar` is a left-border accent for week cards; `dot` is a small status dot for
 * month chips; `chip` is a soft background+text for compact month chips. Falls
 * back to the "low" styling for any unknown urgency string.
 */

export type UrgencyAccent = {
  /** Left-border color class, e.g. for a week-grid card's accent rail. */
  readonly bar: string;
  /** Small dot color (background) for a month chip. */
  readonly dot: string;
  /** Soft chip background + text for compact month chips. */
  readonly chip: string;
};

const ACCENTS: Record<string, UrgencyAccent> = {
  emergency: {
    bar: "border-l-red-500",
    dot: "bg-red-500",
    chip: "bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300",
  },
  high: {
    bar: "border-l-orange-500",
    dot: "bg-orange-500",
    chip: "bg-orange-50 text-orange-700 hover:bg-orange-100 dark:bg-orange-950/40 dark:text-orange-300",
  },
  medium: {
    bar: "border-l-blue-500",
    dot: "bg-blue-500",
    chip: "bg-blue-50 text-blue-700 hover:bg-blue-100 dark:bg-blue-950/40 dark:text-blue-300",
  },
  low: {
    bar: "border-l-gray-400",
    dot: "bg-gray-400",
    chip: "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300",
  },
};

/** The accent classes for an urgency value (defaults to "low" styling). */
export function urgencyAccent(urgency: string): UrgencyAccent {
  return ACCENTS[urgency] ?? ACCENTS.low;
}

/** Ordered urgency legend entries (highest first) for a calendar color key. */
export const URGENCY_LEGEND: readonly {
  readonly urgency: string;
  readonly label: string;
}[] = [
  { urgency: "emergency", label: "Emergency" },
  { urgency: "high", label: "High" },
  { urgency: "medium", label: "Medium" },
  { urgency: "low", label: "Low" },
];
