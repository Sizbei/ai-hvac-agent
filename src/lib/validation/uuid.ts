/**
 * Canonical UUID validation. Admin `[id]` route handlers must guard the path
 * param before it reaches a `uuid`-typed Postgres column — an unvalidated
 * non-UUID (e.g. a hand-typed URL) otherwise 500s on the cast instead of
 * returning a clean 404/400.
 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_REGEX.test(value);
}
