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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// An internal code like "time_off" or "fieldpulse_invoice_pull".
const SNAKE_CODE = /^[a-z0-9]+(_[a-z0-9]+)+$/;
// Keys whose values are field names, which read better as words.
const FIELD_NAME_KEYS = new Set(['fields', 'keys', 'changed', 'changedFields']);
// Keys whose plain humanized label reads wrong.
const KEY_LABELS: Readonly<Record<string, string>> = {
  fieldpulseInvoiceId: 'FieldPulse invoice',
  hcpInvoiceId: 'Housecall Pro invoice',
};
// Codes with a better name than their words.
const VALUE_LABELS: Readonly<Record<string, string>> = {
  fieldpulse_invoice_pull: 'FieldPulse sync',
  hcp_invoice_pull: 'Housecall Pro sync',
};

/** True when a string is a row id (a UUID). */
export function isAuditId(value: unknown): boolean {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * Every id in a details payload, so the server can look up a display label
 * (a staff name, a request number) for each. Non-JSON payloads have none.
 */
export function auditDetailIds(details: string | null): string[] {
  const parsed = parseDetails(details);
  if (!parsed) return [];
  const ids: string[] = [];
  for (const value of Object.values(parsed)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      if (typeof v === 'string' && isAuditId(v)) ids.push(v.toLowerCase());
    }
  }
  return ids;
}

function parseDetails(details: string | null): Record<string, unknown> | null {
  if (!details) return null;
  try {
    const parsed: unknown = JSON.parse(details);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function formatDetailValue(
  key: string,
  value: unknown,
  refs: Readonly<Record<string, string>>,
): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const items = value
      .map((v) => formatDetailValue(key, v, refs))
      .filter((v): v is string => v !== null);
    return items.length > 0 ? items.join(', ') : null;
  }
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' && /Cents$/.test(key)) {
    return (value / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  }
  if (typeof value === 'string') {
    // An id is only worth showing as the name it stands for.
    if (isAuditId(value)) return refs[value.toLowerCase()] ?? null;
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
    if (VALUE_LABELS[value]) return VALUE_LABELS[value];
    if (SNAKE_CODE.test(value)) return value.replace(/_/g, ' ');
    return value;
  }
  return String(value);
}

/** Label for a details key: "technicianIds" → "Technicians", "totalCents" → "Total". */
function detailLabel(key: string, value: unknown): string {
  if (KEY_LABELS[key]) return KEY_LABELS[key];
  const isIdValue = isAuditId(value) || (Array.isArray(value) && value.some(isAuditId));
  if (isIdValue) {
    if (/Ids$/.test(key)) return humanizeDetailKey(key.replace(/Ids$/, '')) + 's';
    if (/Id$/.test(key)) return humanizeDetailKey(key.replace(/Id$/, ''));
  }
  if (/Cents$/.test(key) && typeof value === 'number') {
    return humanizeDetailKey(key.replace(/Cents$/, ''));
  }
  return humanizeDetailKey(key);
}

/**
 * The audit `details` JSON (field names / ids / enums only, never PII) as one
 * readable line: "From: Oct 6, 2026 · Native row count: 7". Ids show as the
 * label `refs` gives them (a staff name, a request number) and are left out
 * when there is none; empty values are left out too. A row that isn't JSON
 * shows nothing rather than echoing free text that could hold a leaked value.
 */
export function formatAuditDetails(
  details: string | null,
  refs: Readonly<Record<string, string>> = {},
): string | null {
  const parsed = parseDetails(details);
  if (!parsed) return null;
  const parts = Object.entries(parsed).flatMap(([k, v]) => {
    const formatted = formatDetailValue(k, v, refs);
    if (formatted === null) return [];
    return [`${detailLabel(k, v)}: ${formatted || '—'}`];
  });
  return parts.length > 0 ? parts.join(' · ') : null;
}
