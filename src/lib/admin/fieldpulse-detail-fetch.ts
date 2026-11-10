/**
 * The invoice and estimate list endpoints don't carry the FieldPulse spillover
 * blob (speed S3 payload trim: it was ~75% of a list page). An expanded list
 * row reads it from the record's detail endpoint instead.
 */
export type FieldpulseDetailRecord = "invoice" | "estimate";

/** The record's detail endpoint (unchanged by the trim). */
export function fieldpulseDetailUrl(record: FieldpulseDetailRecord, id: string): string {
  return `/api/admin/${record}s/${encodeURIComponent(id)}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `fieldpulseData` from a detail response body (`{ data: { invoice | estimate } }`),
 * or null when the body isn't that shape or the record has no FieldPulse data.
 */
export function fieldpulseDataFromDetail(
  body: unknown,
  record: FieldpulseDetailRecord,
): Record<string, unknown> | null {
  if (!isPlainObject(body) || !isPlainObject(body.data)) return null;
  const row = body.data[record];
  if (!isPlainObject(row)) return null;
  return isPlainObject(row.fieldpulseData) ? row.fieldpulseData : null;
}
