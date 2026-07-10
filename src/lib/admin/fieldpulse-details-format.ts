/**
 * Pure label/format helpers for the FieldPulse details collapsible panel.
 *
 * These helpers are intentionally kept in a .ts file (no JSX) so they can be
 * tested in the node environment without a DOM.
 */

/**
 * Convert a snake_case key to Title Case (spaces + capitalised words).
 * "due_date" → "Due Date", "is_tax_exempt" → "Is Tax Exempt".
 */
export function humanizeKey(key: string): string {
  return key
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Format a single field value for display.
 * - boolean: "Yes" / "No"
 * - string that looks like an ISO date (≥10 chars, starts YYYY-): locale date
 * - array: CSV of its string elements (shallow)
 * - number: string coercion
 * - string: as-is
 * - null / undefined: treated as empty (callers should skip those)
 */
export function formatValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (typeof value === "string") {
    // ISO date detection: "YYYY-MM-DD..." pattern
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
      const d = new Date(value);
      if (!isNaN(d.getTime())) {
        return d.toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
      }
    }
    return value;
  }

  if (typeof value === "number") return String(value);

  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === "string" ? v : String(v)))
      .join(", ");
  }

  return String(value);
}

export interface FieldpulseEntry {
  readonly label: string;
  readonly value: string;
}

/**
 * Convert a fieldpulse_data jsonb object into a sorted, display-ready list of
 * label/value pairs. Returns null when data is null/empty.
 *
 * - Skips null, undefined, empty string, empty array values
 * - Sorts entries alphabetically by label for stable rendering
 * - Objects (non-array) are skipped — they should have been promoted to columns
 */
export function buildFieldpulseEntries(
  data: Record<string, unknown> | null | undefined,
): FieldpulseEntry[] | null {
  if (data == null) return null;

  const entries: FieldpulseEntry[] = [];

  for (const [key, value] of Object.entries(data)) {
    // Skip null / undefined / empty string
    if (value == null || value === "") continue;
    // Skip empty arrays
    if (Array.isArray(value) && value.length === 0) continue;
    // Skip plain objects (should have been promoted; not safe to stringify)
    if (typeof value === "object" && !Array.isArray(value)) continue;

    entries.push({ label: humanizeKey(key), value: formatValue(value) });
  }

  if (entries.length === 0) return null;

  return entries.sort((a, b) => a.label.localeCompare(b.label));
}
