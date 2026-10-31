/**
 * Stand-in customer sessions.
 *
 * service_requests.session_id is NOT NULL, so every write path that creates a
 * request WITHOUT a conversation inserts a synthetic "submitted" web session:
 * office bookings (`admin-`, create-request-queries.ts), membership visits
 * (`mvisit-`, membership-visit-queries.ts) and the FieldPulse import
 * (`fp-import-`, integrations/fieldpulse/import/jobs.ts). They are not chats,
 * so conversation lists and bot/AI analytics must exclude them.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

export const ADMIN_SESSION_TOKEN_PREFIX = "admin-";

export const STAND_IN_SESSION_TOKEN_PREFIXES = [
  ADMIN_SESSION_TOKEN_PREFIX,
  "mvisit-",
  "fp-import-",
] as const;

export function isStandInSessionToken(token: string): boolean {
  return STAND_IN_SESSION_TOKEN_PREFIXES.some((p) => token.startsWith(p));
}

const [ADMIN_PATTERN, MVISIT_PATTERN, FP_IMPORT_PATTERN] =
  STAND_IN_SESSION_TOKEN_PREFIXES.map((p) => `${p}%`);

/** SQL predicate: the session token is NOT a stand-in. (No prefix contains a
 * LIKE metacharacter, so the patterns need no escaping; token is NOT NULL.)
 * Built from the bare `sql` tag only, so query modules that mock drizzle-orm
 * in their unit tests keep working. */
export function notStandInSession(tokenColumn: AnyPgColumn): SQL {
  return sql`NOT (${tokenColumn} LIKE ${ADMIN_PATTERN} OR ${tokenColumn} LIKE ${MVISIT_PATTERN} OR ${tokenColumn} LIKE ${FP_IMPORT_PATTERN})`;
}
