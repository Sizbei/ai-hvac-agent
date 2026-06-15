/**
 * Map Fieldpulse users to our opaque technician roster ids.
 *
 * Mirrors housecall-pro/technician-mapping.ts: derive a synthetic technician id
 * from a Fieldpulse user record, filtering to active staff only. The mapping is
 * deterministic (same user → same id) and opaque (prefix + user id) so no PII
 * crosses the boundary.
 */

import type { FieldpulseUser } from "./types";

/** Opaque technician id prefix for Fieldpulse users. */
const FIELDPULSE_TECH_PREFIX = "fp_";

/**
 * Derive an opaque technician id from a Fieldpulse user record.
 * Returns null when the user has no id (malformed row).
 *
 * The mapping is deterministic: same user → same id.
 */
export function mapFieldpulseUserToTechnicianId(
  user: FieldpulseUser,
): string | null {
  if (!user.id || user.id.length === 0) {
    return null;
  }
  return `${FIELDPULSE_TECH_PREFIX}${user.id}`;
}

/**
 * Map a list of Fieldpulse users to our opaque technician ids, filtering to
 * active staff only (isActive = true). When isActive is undefined/null, we
 * conservatively include the user (better to over-report than under-report).
 */
export function mapFieldpulseUsers(
  users: readonly FieldpulseUser[],
): readonly string[] {
  return users
    .filter((u) => u.isActive !== false) // Include unless explicitly inactive
    .map((u) => mapFieldpulseUserToTechnicianId(u))
    .filter((id): id is string => id !== null);
}
