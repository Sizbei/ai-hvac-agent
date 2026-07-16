/**
 * True when `error` — or any error in its `.cause` chain — is a Postgres
 * unique-violation (SQLSTATE 23505).
 *
 * CRITICAL: Drizzle wraps the driver error in a `DrizzleQueryError` whose
 * top-level `.code` is `undefined`; the real code + `.constraint` live on
 * `.cause` (the NeonDbError). Checking only the top level (as the per-route
 * copies used to) never matches, so a duplicate 500s instead of 409ing. This
 * unwraps up to 4 levels.
 *
 * Pass `constraint` to require a specific unique index — matched against the pg
 * error's `.constraint` field or its message text.
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  let e: unknown = error;
  for (let depth = 0; e != null && depth < 4; depth++) {
    const rec = e as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (rec.code === "23505") {
      if (!constraint) return true;
      return (
        rec.constraint === constraint ||
        (typeof rec.message === "string" && rec.message.includes(constraint))
      );
    }
    e = rec.cause;
  }
  return false;
}
