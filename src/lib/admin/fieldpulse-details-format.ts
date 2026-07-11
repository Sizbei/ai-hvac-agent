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

// ─── buildFieldpulseSections ─────────────────────────────────────────────────

export type SectionTitle = "Money" | "Dates" | "Flags" | "IDs" | "Other";

export interface FieldpulseSection {
  readonly title: SectionTitle;
  readonly entries: readonly FieldpulseEntry[];
}

export interface FieldpulseSectionsResult {
  readonly sections: readonly FieldpulseSection[];
  readonly preview: readonly string[];
  readonly hiddenCount: number;
}

/** Returns true when key ends with /(rate|percent)$/ — percent wins over money. */
function isPercentKey(key: string): boolean {
  return /(rate|percent)$/.test(key);
}

/** Returns true when key matches money pattern AND value is numeric. */
function isMoneyKey(key: string): boolean {
  return /(price|total|subtotal|tax|cost|discount|commission|surcharge|amount)/.test(key);
}

/** Returns true when key matches a date pattern. */
function isDateKey(key: string): boolean {
  return /(_at|_date)$/.test(key);
}

/** Returns true when key looks like an ID field. */
function isIdKey(key: string): boolean {
  return /(_id|^id)s?$/.test(key);
}

/** Returns true when value is a numeric string or number (and non-empty). */
function isNumericValue(value: unknown): boolean {
  if (typeof value === "number") return true;
  if (typeof value === "string" && value.trim() !== "") {
    return !isNaN(Number(value));
  }
  return false;
}

function formatMoney(value: unknown): string {
  const n = Number(value);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

function formatPercent(value: unknown): string {
  return `${value}%`;
}

function formatDateString(value: string): string {
  // Handle both "YYYY-MM-DD HH:mm:ss" and ISO strings
  // Replace space separator with T for consistent parsing
  const normalised = value.replace(" ", "T");
  const d = new Date(normalised);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Classify and format a single top-level key/value pair.
 * Returns { section, label, value } or null if the value should be skipped.
 * Returns { section: null, label, value } for nested-object markers that go to hiddenCount.
 */
function classifyEntry(
  key: string,
  value: unknown,
  parentLabel?: string,
): { section: SectionTitle; label: string; value: string } | null {
  // Skip null / undefined / empty string
  if (value == null || value === "") return null;
  // Skip empty arrays
  if (Array.isArray(value) && value.length === 0) return null;

  const label = parentLabel ? `${parentLabel} · ${humanizeKey(key)}` : humanizeKey(key);

  // Boolean → Flags
  if (typeof value === "boolean") {
    return { section: "Flags", label, value: value ? "Yes" : "No" };
  }

  // Arrays of scalars → join as CSV, classify by key
  if (Array.isArray(value)) {
    const joined = value.map((v) => (typeof v === "string" ? v : String(v))).join(", ");
    return { section: "Other", label, value: joined };
  }

  // Date keys with parseable value → Dates
  if (isDateKey(key) && (typeof value === "string" || typeof value === "number")) {
    const formatted = formatDateString(String(value));
    return { section: "Dates", label, value: formatted };
  }

  // ID keys → IDs
  if (isIdKey(key)) {
    return { section: "IDs", label, value: String(value) };
  }

  // Percent keys win over money (tax_rate matches both; percent takes priority)
  if (isPercentKey(key) && isNumericValue(value)) {
    return { section: "Other", label, value: formatPercent(value) };
  }

  // Money keys with numeric values → Money
  if (isMoneyKey(key) && isNumericValue(value)) {
    return { section: "Money", label, value: formatMoney(value) };
  }

  // Fallback → Other
  return { section: "Other", label, value: String(value) };
}

/**
 * Convert a fieldpulse_data jsonb object into grouped, formatted sections.
 *
 * Sections order: Money, Dates, Flags, IDs, Other (empty sections omitted).
 * Within each section entries are sorted alphabetically by label.
 * preview = first 3 entries from Money+Dates as "label: value" strings.
 * hiddenCount = count of fields that were too deeply nested to show.
 */
export function buildFieldpulseSections(
  data: Record<string, unknown> | null | undefined,
): FieldpulseSectionsResult {
  const empty: FieldpulseSectionsResult = { sections: [], preview: [], hiddenCount: 0 };
  if (data == null) return empty;

  const buckets: Record<SectionTitle, FieldpulseEntry[]> = {
    Money: [],
    Dates: [],
    Flags: [],
    IDs: [],
    Other: [],
  };
  let hiddenCount = 0;

  for (const [key, value] of Object.entries(data)) {
    // Skip null / undefined / empty string / empty array
    if (value == null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;

    // One-level object flattening
    if (typeof value === "object" && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      for (const [childKey, childValue] of Object.entries(nested)) {
        if (childValue == null || childValue === "") continue;
        if (Array.isArray(childValue) && childValue.length === 0) continue;
        // Deeper nesting → hiddenCount
        if (typeof childValue === "object" && !Array.isArray(childValue)) {
          hiddenCount++;
          continue;
        }
        const entry = classifyEntry(childKey, childValue, humanizeKey(key));
        if (entry) {
          buckets[entry.section].push({ label: entry.label, value: entry.value });
        }
      }
      continue;
    }

    const entry = classifyEntry(key, value);
    if (entry) {
      buckets[entry.section].push({ label: entry.label, value: entry.value });
    }
  }

  const ORDER: SectionTitle[] = ["Money", "Dates", "Flags", "IDs", "Other"];
  const sections: FieldpulseSection[] = ORDER
    .filter((title) => buckets[title].length > 0)
    .map((title) => ({
      title,
      entries: [...buckets[title]].sort((a, b) => a.label.localeCompare(b.label)),
    }));

  // preview: first 3 entries from Money + Dates
  const previewEntries: string[] = [];
  for (const title of ["Money", "Dates"] as SectionTitle[]) {
    const sec = sections.find((s) => s.title === title);
    if (sec) {
      for (const e of sec.entries) {
        if (previewEntries.length >= 3) break;
        previewEntries.push(`${e.label}: ${e.value}`);
      }
    }
    if (previewEntries.length >= 3) break;
  }

  return { sections, preview: previewEntries, hiddenCount };
}
