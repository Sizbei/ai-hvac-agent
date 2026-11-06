/**
 * Search predicates over the contact details a conversation captured.
 *
 * customer_sessions.metadata is the intake's JSON slot bag. Matching the raw
 * text matched JSON keys ("customerPhone" returned every session) and internal
 * slot fields, and a digits search ran over web session tokens and every
 * digit in the blob joined together. These predicates read only the contact
 * keys, and only the phone part of an SMS token.
 *
 * Built from the bare `sql` tag with the columns passed in (like
 * notStandInSession), so query modules that mock drizzle-orm keep working.
 */
import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** Metadata keys that hold the customer's contact details. */
export const SESSION_CONTACT_KEYS = [
  "customerName",
  "customerPhone",
  "customerEmail",
  "address",
] as const;

/** One metadata key's text; NULL for a missing key or non-JSON metadata. */
function metadataKey(metadata: AnyPgColumn, key: string): SQL {
  return sql`(CASE WHEN ${metadata} IS JSON OBJECT THEN (${metadata})::jsonb ->> ${key}::text END)`;
}

/** Any contact key ILIKE the (already escaped) pattern. */
export function sessionContactMatches(metadata: AnyPgColumn, pattern: string): SQL {
  const clauses = SESSION_CONTACT_KEYS.map(
    (key) => sql`${metadataKey(metadata, key)} ILIKE ${pattern}`,
  );
  return sql`(${sql.join(clauses, sql` OR `)})`;
}

/**
 * The captured phone, or an SMS thread's number ("sms:<phone>", or
 * "sms:<phone>:<session id>" once retired), contains these digits however
 * either side was formatted.
 */
export function sessionPhoneDigitsMatch(
  metadata: AnyPgColumn,
  token: AnyPgColumn,
  digits: string,
): SQL {
  const pattern = `%${digits}%`;
  return sql`(regexp_replace(coalesce(${metadataKey(metadata, "customerPhone")}, ''), '[^0-9]', '', 'g') LIKE ${pattern}
    OR (${token} LIKE 'sms:%' AND regexp_replace(split_part(${token}, ':', 2), '[^0-9]', '', 'g') LIKE ${pattern}))`;
}
