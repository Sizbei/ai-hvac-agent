/**
 * Tests for the pure customers-phase split helpers (SPEC §2.0/§2.1, §6 items
 * 2, 7 and 8).
 *
 * These pin the decisions that decide whether an FP customer gets its own row:
 * which native row may be claimed, when a claim is refused, and when a flagged
 * run must refuse to start at all. No database — every function here is pure.
 */
import { describe, it, expect } from "vitest";
import {
  LEGACY_CONTACT_UNIQUE_INDEXES,
  NATIVE_CLAIM_CANDIDATE_FILTER_SQL,
  resolveFpCustomerAction,
  shouldAbortForLegacyContactUniques,
  type FpCustomerActionInput,
  type NativeCandidateRow,
} from "./customer-resolution";

function emailCandidate(
  overrides: Partial<NativeCandidateRow> = {},
): NativeCandidateRow {
  return {
    id: "native-1",
    matchedOn: "email",
    fieldpulseCustomerId: null,
    ...overrides,
  };
}

function input(
  overrides: Partial<FpCustomerActionInput> = {},
): FpCustomerActionInput {
  return {
    existingByFpId: null,
    archivedImport: false,
    candidateNativeRow: null,
    candidateClaimedEarlierThisRun: false,
    ...overrides,
  };
}

describe("resolveFpCustomerAction", () => {
  it("fp-id hit → update", () => {
    expect(
      resolveFpCustomerAction(input({ existingByFpId: { anonymizedAt: null } })),
    ).toEqual({ kind: "update" });
  });

  it("fp-id hit on an erased row → skip-anonymized (never re-import PII)", () => {
    expect(
      resolveFpCustomerAction(
        input({ existingByFpId: { anonymizedAt: new Date("2026-07-01") } }),
      ),
    ).toEqual({ kind: "skip-anonymized" });
  });

  it("the fp-id hit wins over every later step", () => {
    // An erased row must stay erased even when a claimable candidate exists.
    expect(
      resolveFpCustomerAction(
        input({
          existingByFpId: { anonymizedAt: new Date("2026-07-01") },
          archivedImport: true,
          candidateNativeRow: emailCandidate(),
        }),
      ),
    ).toEqual({ kind: "skip-anonymized" });
  });

  it("deleted/merged FP record → insert-archived", () => {
    expect(
      resolveFpCustomerAction(input({ archivedImport: true })),
    ).toEqual({ kind: "insert-archived" });
  });

  it("a deleted/merged record is never claimed, even with an email candidate", () => {
    // upsert-by-contact would un-archive a returning customer; the archived
    // import must stay keyed on its own fp id.
    expect(
      resolveFpCustomerAction(
        input({ archivedImport: true, candidateNativeRow: emailCandidate() }),
      ),
    ).toEqual({ kind: "insert-archived" });
  });

  it("native candidate matched on email → claim", () => {
    expect(
      resolveFpCustomerAction(input({ candidateNativeRow: emailCandidate() })),
    ).toEqual({ kind: "claim" });
  });

  it("candidate matched on phone only → insert (a phone is not an identity)", () => {
    // The claim carries the row's portal token, so a shared office line would
    // hand one customer another's invoices. Two rows, no false merge.
    expect(
      resolveFpCustomerAction(
        input({ candidateNativeRow: emailCandidate({ matchedOn: "phone" }) }),
      ),
    ).toEqual({ kind: "insert" });
  });

  it("candidate already claimed earlier this run → insert (contested)", () => {
    // FP list order carries no identity meaning, so first-arrival must not win.
    expect(
      resolveFpCustomerAction(
        input({
          candidateNativeRow: emailCandidate(),
          candidateClaimedEarlierThisRun: true,
        }),
      ),
    ).toEqual({ kind: "insert" });
  });

  it("no candidate → insert", () => {
    expect(resolveFpCustomerAction(input())).toEqual({ kind: "insert" });
  });

  /**
   * Guard against future widening — NOT live behaviour. The real candidate
   * query filters `fieldpulse_customer_id IS NULL`, so a candidate owned by
   * another FP customer cannot reach this function today. If someone relaxes
   * that filter, this keeps the resolver from stamping a second fp id onto a
   * row that already belongs to someone else.
   */
  it("candidate already owned by a different fp id → insert (guard, unreachable today)", () => {
    expect(
      resolveFpCustomerAction(
        input({
          candidateNativeRow: emailCandidate({ fieldpulseCustomerId: "99999" }),
        }),
      ),
    ).toEqual({ kind: "insert" });
  });

  it("the candidate filter still excludes fp-linked rows, so that guard stays unreachable", () => {
    expect(NATIVE_CLAIM_CANDIDATE_FILTER_SQL).toContain(
      "fieldpulse_customer_id IS NULL",
    );
  });
});

/**
 * The claim-pick rule (§2.1 step 3, §6 item 8). The candidate set is NOT
 * pickCustomerMatch's: that ordering puts do-not-service first so a refusal
 * cannot be bypassed, which here would preferentially stamp an FP identity onto
 * a blocked row — the opposite of what is wanted.
 */
describe("NATIVE_CLAIM_CANDIDATE_FILTER_SQL", () => {
  it("excludes do-not-service rows, so a blocked row is never claimed", () => {
    expect(NATIVE_CLAIM_CANDIDATE_FILTER_SQL).toContain("do_not_service = false");
  });

  it("excludes erased and archived rows", () => {
    expect(NATIVE_CLAIM_CANDIDATE_FILTER_SQL).toContain("anonymized_at IS NULL");
    expect(NATIVE_CLAIM_CANDIDATE_FILTER_SQL).toContain("archived_at IS NULL");
  });

  it("carries every term, so the SELECT and the guarded UPDATE cannot drift apart", () => {
    // One constant, used by both statements — that is the TOCTOU protection:
    // the phase runs ~20 minutes and nothing pauses an operator.
    expect(NATIVE_CLAIM_CANDIDATE_FILTER_SQL.split(" AND ")).toHaveLength(4);
  });
});

describe("shouldAbortForLegacyContactUniques", () => {
  it("aborts when the legacy email unique is still present", () => {
    expect(
      shouldAbortForLegacyContactUniques([
        { indexname: "customers_org_email_hash_unique" },
      ]),
    ).toBe(true);
  });

  it("aborts when the legacy phone unique is still present", () => {
    expect(
      shouldAbortForLegacyContactUniques([
        { indexname: "customers_org_phone_hash_unique" },
      ]),
    ).toBe(true);
  });

  it("proceeds on an empty probe result", () => {
    expect(shouldAbortForLegacyContactUniques([])).toBe(false);
  });

  it("proceeds when only the new native uniques are present", () => {
    expect(
      shouldAbortForLegacyContactUniques([
        { indexname: "customers_org_email_hash_native_unique" },
        { indexname: "customers_org_phone_hash_native_unique" },
        { indexname: "customers_org_email_hash_idx" },
      ]),
    ).toBe(false);
  });

  it("ignores rows with no indexname rather than throwing", () => {
    expect(shouldAbortForLegacyContactUniques([{ indexname: null }, {}])).toBe(
      false,
    );
  });

  it("names both legacy indexes, so neither can be dropped from the probe", () => {
    expect(LEGACY_CONTACT_UNIQUE_INDEXES).toEqual([
      "customers_org_email_hash_unique",
      "customers_org_phone_hash_unique",
    ]);
  });
});
