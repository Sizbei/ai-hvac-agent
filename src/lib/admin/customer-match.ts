import { sql, type SQL } from "drizzle-orm";
import { customers } from "@/lib/db/schema";

/**
 * Deterministic pick order for contact lookups.
 *
 * `customers` is no longer one row per contact: FieldPulse-linked rows keep
 * their own row per FP customer id and may legitimately share an email or a
 * phone (one accounts-payable contact covers many unrelated businesses), so a
 * single email/phone can answer with several rows. Every identity lookup
 * therefore needs a documented, stable order instead of a bare `LIMIT 1`.
 *
 * This module is pure — no database, no crypto — so the order is unit-testable.
 * The candidate SELECT that feeds it lives in `crm-queries.ts` and mirrors
 * rules 2-7 in its `ORDER BY` (which is what makes its `LIMIT` safe); rule 1 is
 * a filter and lives in that query's `WHERE`. The helper re-applies rule 1 and
 * re-sorts anyway: it must not depend on the caller's SQL being right.
 */

/** One row that answered the contact lookup. */
export interface CustomerMatchCandidate {
  readonly id: string;
  /** Which blind index matched — email is the stronger identity key (rule 3). */
  readonly matchedOn: "email" | "phone";
  /** Erasure marker: an anonymized row is never a match (rule 1). */
  readonly anonymizedAt: Date | null;
  readonly archivedAt: Date | null;
  readonly doNotService: boolean;
  readonly createdAt: Date | null;
  /** Newest service request for the row, or null when it has none. */
  readonly lastActivityAt: Date | null;
}

/**
 * The resolved identity. `doNotService` is carried out so callers can make a
 * LOCAL decision (e.g. the un-archive gate) without a second read; the refusal
 * itself still re-reads the flag from the id, exactly as it does today.
 * `ambiguous` is true when more than one LIVE candidate survived rule 1 —
 * identity surfaces treat that as "no confident identity".
 */
export interface CustomerMatch {
  readonly id: string;
  readonly ambiguous: boolean;
  readonly doNotService: boolean;
}

/**
 * Candidate cap for the lookup SELECT. Post-split fan-out per contact is not
 * bounded by anything in the schema, and an unbounded candidate read sits on
 * the intake path. Safe because the SQL `ORDER BY` mirrors rules 2-7 and rule 1
 * is in the `WHERE`: the cap can only drop rows that would have ranked below
 * the winner.
 */
export const CUSTOMER_MATCH_CANDIDATE_LIMIT = 50;

/**
 * Rule 1 as SQL. An erased row must never be resolved. Erasure already NULLs
 * both hashes, so this is belt-and-braces — but it is the invariant that must
 * not depend on another module's behaviour, so it lives in the candidate
 * query's `WHERE` and is exported here as the single source of that term.
 *
 * A function, not a module-level constant: several unrelated suites mock
 * `@/lib/db/schema` without a `customers` export, and touching the column while
 * this module loads would break them at import time.
 */
export function customerMatchCandidatePredicate(): SQL {
  return sql`${customers.anonymizedAt} IS NULL`;
}

/** Descending date order with NULLs last (rules 5 and 6). */
function compareDatesDesc(a: Date | null, b: Date | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b.getTime() - a.getTime();
}

function compareCandidates(
  a: CustomerMatchCandidate,
  b: CustomerMatchCandidate,
): number {
  // Rule 2 — do-not-service wins. Fail-closed: picking the unblocked sibling of
  // a blocked row would silently bypass the refusal the flag exists for.
  if (a.doNotService !== b.doNotService) return a.doNotService ? -1 : 1;

  // Rule 3 — an email match beats a phone match. Phone numbers collide between
  // unrelated people (office lines, property managers, dispatcher placeholders);
  // a shared email is far stronger evidence of a shared billing identity.
  if (a.matchedOn !== b.matchedOn) return a.matchedOn === "email" ? -1 : 1;

  // Rule 4 — a live row beats an archived one; a dormant row must not outrank a
  // live business.
  const aArchived = a.archivedAt !== null;
  const bArchived = b.archivedAt !== null;
  if (aArchived !== bArchived) return aArchived ? 1 : -1;

  // Rule 5 — "the business we most recently worked with".
  const byActivity = compareDatesDesc(a.lastActivityAt, b.lastActivityAt);
  if (byActivity !== 0) return byActivity;

  // Rule 6 — newest identity when no activity separates them.
  const byCreated = compareDatesDesc(a.createdAt, b.createdAt);
  if (byCreated !== 0) return byCreated;

  // Rule 7 — determinism backstop: two identical calls must not disagree.
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * Picks the winning row for a contact lookup, or null when nothing survives.
 *
 * Ambiguity never softens rule 2: an ambiguous cluster still resolves to the
 * do-not-service row's id, because returning null there would let a blocked
 * business book by sharing a contact with an unblocked one.
 */
export function pickCustomerMatch(
  candidates: readonly CustomerMatchCandidate[],
): CustomerMatch | null {
  // Rule 1 — an erased row is not a candidate at all.
  const eligible = candidates.filter(
    (candidate) => candidate.anonymizedAt === null,
  );
  if (eligible.length === 0) return null;

  const [winner] = [...eligible].sort(compareCandidates);
  const liveCount = eligible.filter(
    (candidate) => candidate.archivedAt === null,
  ).length;

  return {
    id: winner.id,
    ambiguous: liveCount > 1,
    doNotService: winner.doNotService,
  };
}
