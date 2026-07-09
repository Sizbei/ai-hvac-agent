/**
 * FieldPulse date parsing — PURE module (no db/server imports) so it stays
 * unit-testable.
 *
 * The FP API returns dates as "2026-07-01 10:00:00" (space-separated, no zone)
 * or "2026-08-01" (date-only). JS `new Date()` treats the space form as LOCAL
 * time, which would make the same import produce different instants on a
 * laptop vs. a UTC lambda — so we normalize the space to a "T" and pin the
 * zone to UTC. FP doesn't publish its serialization zone; for day-granularity
 * aging that's the right trade.
 */
export function parseFpDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // "2026-07-01 10:00:00" → "2026-07-01T10:00:00Z"; "2026-08-01" is already
  // parsed as UTC per the ISO date-only rule, but pin it explicitly anyway.
  let normalized = trimmed.replace(" ", "T");
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  if (!hasZone) {
    normalized = /T/.test(normalized) ? `${normalized}Z` : `${normalized}T00:00:00Z`;
  }

  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
