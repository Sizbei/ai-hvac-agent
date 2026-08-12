/**
 * Pure decision helpers for the customers phase's `--split-shared-contacts`
 * resolution (SPEC §2.0/§2.1). No database, no I/O — everything here is a
 * function of its arguments so the resolution order is testable without a
 * Postgres connection.
 *
 * The flagged path is the ONLY consumer. The unflagged (nightly) path is
 * today's code, untouched: see `importOneFpCustomer`.
 */

// ── Candidate filter ─────────────────────────────────────────────────────────

/**
 * The filter that decides which native rows may be claimed by an FP customer
 * (SPEC §2.1 step 3). Exported, and used verbatim by BOTH the candidate SELECT
 * and the guarded claim UPDATE, because the two predicates must match term for
 * term: the phase runs for ~20 minutes and nothing pauses an operator, so a row
 * archived or blocked between the SELECT and the UPDATE must not be claimed.
 *
 * `do_not_service = false` is deliberate and is NOT `pickCustomerMatch`'s
 * ordering: that pick puts do-not-service FIRST so a refusal cannot be
 * bypassed, which here would preferentially stamp an FP identity onto a blocked
 * row. A do-not-service native row is never claimed; the FP customer gets its
 * own fresh row instead.
 */
export const NATIVE_CLAIM_CANDIDATE_FILTER_SQL =
  "fieldpulse_customer_id IS NULL AND anonymized_at IS NULL AND archived_at IS NULL AND do_not_service = false";

// ── Resolution order ─────────────────────────────────────────────────────────

/** A claimable native row, as returned by the candidate query. */
export interface NativeCandidateRow {
  readonly id: string;
  /**
   * Which blind index matched. The real candidate query only ever matches on
   * email (SPEC §2.1: a claim carries the row's portal token, so a phone
   * collision would hand one customer another's invoices). "phone" exists so
   * the phone-only outcome is expressible — and pinned — by the tests.
   */
  readonly matchedOn: "email" | "phone";
  /**
   * Always null through the real query, which filters
   * `fieldpulse_customer_id IS NULL`. Kept as an input so a future widening of
   * that filter cannot silently start claiming another FP customer's row.
   */
  readonly fieldpulseCustomerId: string | null;
}

export interface FpCustomerActionInput {
  /** The row already keyed on this FP customer id, if any. */
  readonly existingByFpId: { readonly anonymizedAt: Date | null } | null;
  /** The FP record is deleted/merged upstream (`mapFpCustomer.archivedImport`). */
  readonly archivedImport: boolean;
  /** The oldest claimable native row for this customer's email, if any. */
  readonly candidateNativeRow: NativeCandidateRow | null;
  /** Another FP customer in THIS run already claimed that candidate. */
  readonly candidateClaimedEarlierThisRun: boolean;
}

export type FpCustomerAction =
  | { readonly kind: "skip-anonymized" }
  | { readonly kind: "update" }
  | { readonly kind: "insert-archived" }
  | { readonly kind: "claim" }
  | { readonly kind: "insert" };

/**
 * SPEC §2.1's resolution order, as a pure function — flagged path only.
 *
 * `insert` is the catch-all on purpose: an FP customer must never end a run
 * with no row. Every reason a claim is unavailable (no candidate, phone-only
 * match, contested within the run, or a candidate that somehow already carries
 * an fp id) resolves to "insert this FP customer's own row".
 */
export function resolveFpCustomerAction(
  input: FpCustomerActionInput,
): FpCustomerAction {
  // 1. By fp id — including the erasure guard, which never re-imports PII.
  if (input.existingByFpId) {
    return input.existingByFpId.anonymizedAt
      ? { kind: "skip-anonymized" }
      : { kind: "update" };
  }

  // 2. Deleted / merged FP record — archived, contactless, keyed on the fp id.
  if (input.archivedImport) return { kind: "insert-archived" };

  // 3. Claim a native row — on the email blind index only.
  const candidate = input.candidateNativeRow;
  if (!candidate) return { kind: "insert" };
  if (candidate.matchedOn !== "email") return { kind: "insert" };
  // Unreachable through the real query (see NativeCandidateRow) — a guard
  // against a future widening of the candidate filter, not live behaviour.
  if (candidate.fieldpulseCustomerId !== null) return { kind: "insert" };
  // Contested: FP list order carries no identity meaning, so the second FP
  // customer to select a candidate does not get it.
  if (input.candidateClaimedEarlierThisRun) return { kind: "insert" };

  return { kind: "claim" };
}

// ── Pre-flight index probe ───────────────────────────────────────────────────

/**
 * The two per-org contact uniques migration 0046 drops. Running the split
 * against a schema that still carries them is the error storm the flag exists
 * to prevent, so the phase probes for them and aborts loudly.
 */
export const LEGACY_CONTACT_UNIQUE_INDEXES = [
  "customers_org_email_hash_unique",
  "customers_org_phone_hash_unique",
] as const;

/**
 * Decide, from a `pg_indexes` probe, whether the flagged phase must abort.
 * Either legacy unique still present → abort. Empty result → proceed.
 */
export function shouldAbortForLegacyContactUniques(
  rows: readonly { readonly indexname?: string | null }[],
): boolean {
  const legacy: readonly string[] = LEGACY_CONTACT_UNIQUE_INDEXES;
  return rows.some(
    (row) => typeof row?.indexname === "string" && legacy.includes(row.indexname),
  );
}
