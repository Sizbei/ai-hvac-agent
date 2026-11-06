/**
 * Sentence-case label for an audit action/entity key: "invoice.reminder_sent"
 * → "Invoice reminder sent". Splits on underscores, dots and spaces.
 */
export function humanizeAuditKey(value: string): string {
  const words = value.split(/[._\s]+/).filter(Boolean);
  if (words.length === 0) return value;
  return [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(' ');
}

/** "nativeRowCount" / "NativeRowCount" → "native row count" (lower case). */
function splitIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[._\s]+/)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Sentence-case label for a details key, camelCase included. */
export function humanizeDetailKey(key: string): string {
  return humanizeAuditKey(splitIdentifier(key));
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
// Keys whose values are field names, which read better as words.
const FIELD_NAME_KEYS = new Set(['fields', 'keys', 'changed', 'changedFields']);

function formatDetailValue(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => formatDetailValue(key, v));
    return items.join(', ');
  }
  if (typeof value === 'string') {
    if (ISO_DATETIME.test(value)) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        const midnightUtc = /T00:00(:00(\.0+)?)?(Z|[+-]00:?00)$/.test(value);
        return date.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          ...(midnightUtc ? { timeZone: 'UTC' } : { hour: 'numeric', minute: '2-digit' }),
        });
      }
    }
    if (FIELD_NAME_KEYS.has(key)) return splitIdentifier(value);
    return value;
  }
  return String(value);
}

/**
 * The audit `details` JSON (field names / ids / enums only, never PII) as one
 * readable line: "From: Oct 6, 2026 · Native row count: 7". A row that isn't
 * JSON shows a neutral placeholder rather than echoing free text that could
 * hold a leaked value.
 */
export function formatAuditDetails(details: string | null): string | null {
  if (!details) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch {
    return '(details unavailable)';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return '(details unavailable)';
  }
  return Object.entries(parsed as Record<string, unknown>)
    .map(([k, v]) => `${humanizeDetailKey(k)}: ${formatDetailValue(k, v) || '—'}`)
    .join(' · ');
}
