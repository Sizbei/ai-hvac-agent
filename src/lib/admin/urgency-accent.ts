/**
 * Urgency → calendar accent classes. Derived from the same semantic families as
 * URGENCY_BADGE in status-colors.ts (emergency = danger, high = warning,
 * medium = info, low = muted) so calendar cards/chips read consistently with
 * the badges.
 *
 * `bar` is a left-border accent for week cards; `dot` is a small square marker
 * for month chips and the legend; `chip` is a soft background+text for compact
 * month chips. Falls back to the "low" styling for any unknown urgency string.
 *
 * LIGHTNESS LADDER (deliberate — the four urgencies must survive greyscale and
 * CVD, per the redesign spec's red/amber collision risk). The `dot`/`bar` fills
 * step monotonically:
 *   medium  --info-strong        L 0.43
 *   emergency --danger           L 0.505
 *   high    --warning            L 0.66
 *   low     --ink-500            L 0.795
 * No two are within 6% lightness, and the closest pair (medium/emergency) is
 * additionally 231° apart in hue.
 */

export type UrgencyAccent = {
  /** Left-border color class, e.g. for a week-grid card's accent rail. */
  readonly bar: string;
  /** Small square marker color (background) for a month chip / legend key. */
  readonly dot: string;
  /** Soft chip background + border + text for compact month chips. */
  readonly chip: string;
};

const ACCENTS: Record<string, UrgencyAccent> = {
  emergency: {
    bar: "border-l-danger",
    dot: "bg-danger",
    chip: "border border-danger-border bg-danger-light text-danger-strong hover:bg-danger-border",
  },
  high: {
    bar: "border-l-warning",
    dot: "bg-warning",
    chip: "border border-warning-border bg-warning-light text-warning-strong hover:bg-warning-border",
  },
  medium: {
    bar: "border-l-info-strong",
    dot: "bg-info-strong",
    chip: "border border-info-border bg-info-light text-info-strong hover:bg-info-border",
  },
  low: {
    bar: "border-l-ink-500",
    dot: "bg-ink-500",
    chip: "border border-border bg-muted text-muted-foreground hover:bg-ink-300",
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
