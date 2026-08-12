/**
 * The opt-in per-FP-customer split (`--split-shared-contacts`, SPEC §2.1).
 *
 * Extracted verbatim from `customers.ts` — this module holds ONLY the flagged
 * path: the split resolution and its write helpers (claim, archived insert,
 * unconditional insert) plus the phase-level `pg_indexes` pre-flight probe.
 * The UNFLAGGED legacy resolution stays in `customers.ts`, untouched.
 *
 * The decision itself is the pure `resolveFpCustomerAction` in
 * `customer-resolution.ts`; the functions here only perform the writes it names.
 */
import { eq, and, asc, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { encrypt } from "@/lib/crypto";
import {
  sanitizeName,
  sanitizePhone,
  sanitizeEmail,
  sanitizeAddress,
} from "@/lib/ai/sanitize-fields";
import { computeContactHashes } from "@/lib/admin/crm-queries";
import type { PhaseResult } from "./run-import";
import { buildFpSpillover } from "./spillover";
import {
  findByFpId,
  updateCustomerFields,
  type MappedFpCustomer,
} from "./customers";
import {
  LEGACY_CONTACT_UNIQUE_INDEXES,
  NATIVE_CLAIM_CANDIDATE_FILTER_SQL,
  resolveFpCustomerAction,
  shouldAbortForLegacyContactUniques,
  type NativeCandidateRow,
} from "./customer-resolution";

// ── Split resolution (--split-shared-contacts, SPEC §2.1) ────────────────────

/**
 * SPEC §2.1's resolution, executed. The decision itself is the pure
 * `resolveFpCustomerAction`; this function only performs the writes it names.
 *
 * Never routes through `upsertCustomerByContact`: that function un-archives a
 * matched row and creates one on a miss, and the claim path must know whether a
 * native row existed so it can decide claim vs insert.
 */
export async function importSplitFpCustomer(
  orgId: string,
  customer: MappedFpCustomer,
  ctx: {
    readonly archivedImport: boolean;
    readonly fpSpillover: ReturnType<typeof buildFpSpillover>;
    readonly existing: { id: string; anonymizedAt: Date | null } | null;
    readonly counts?: PhaseResult;
    readonly claimedThisRun?: Map<string, string>;
  },
): Promise<string | null> {
  const { archivedImport, fpSpillover, existing, counts, claimedThisRun } = ctx;

  const candidate =
    existing || archivedImport
      ? null
      : await selectClaimCandidate(orgId, customer.email);

  const action = resolveFpCustomerAction({
    existingByFpId: existing,
    archivedImport,
    candidateNativeRow: candidate,
    candidateClaimedEarlierThisRun: candidate
      ? claimedThisRun?.has(candidate.id) === true
      : false,
  });

  // 1. By fp id.
  if (existing) {
    if (action.kind === "skip-anonymized") {
      if (counts) counts.skipped++;
      logger.info(
        { orgId, fpId: customer.fpId },
        "FP customer: row is anonymized — refusing to re-import PII over an erasure",
      );
      return existing.id;
    }
    await updateCustomerFields(orgId, existing.id, customer, fpSpillover);
    if (counts) counts.updated++;
    return existing.id;
  }

  // 2. Deleted / merged FP record.
  if (action.kind === "insert-archived") {
    return await insertArchivedFpCustomer(orgId, customer, fpSpillover, counts);
  }

  // 3. Claim the oldest live native row on the email blind index.
  if (action.kind === "claim" && candidate) {
    const claimedId = await claimNativeCustomer(
      orgId,
      customer,
      candidate.id,
      fpSpillover,
    );
    if (claimedId) {
      claimedThisRun?.set(claimedId, customer.fpId);
      // Counted as 'created' for the same reason the legacy path did: the FP
      // customer previously owned no row and now owns one.
      if (counts) counts.created++;
      return claimedId;
    }
    // Zero rows → that row is not available to me (a concurrent run took it, or
    // an operator archived/blocked it between the SELECT and the UPDATE). SPEC
    // §2.3: the response is always the same — insert this FP customer's own
    // row. There is deliberately no error/null path here.
    logger.info(
      { orgId, fpId: customer.fpId },
      "FP customer: guarded claim matched no row — inserting this customer's own row",
    );
  }

  // 4. Insert unconditionally. Subsumes the legacy contactless path: with the
  // contact uniques relaxed there is no reason to branch on "has email/phone".
  return await insertFpCustomer(orgId, customer, fpSpillover, counts);
}

/**
 * The oldest claimable native row for this customer's email, or null.
 *
 * Oldest-first (`created_at ASC`, `id ASC` as the determinism backstop) — NOT
 * `pickCustomerMatch`, whose do-not-service-first ordering would preferentially
 * stamp an FP identity onto a blocked row.
 *
 * Email only, never phone: the claim writes a permanent fp id onto a
 * pre-existing row and carries that row's portal token with it, so a phone
 * collision (an office line, a property manager, a dispatcher's placeholder)
 * would hand one customer another's invoices. A phone-only match falls through
 * to the unconditional insert — two rows, no false merge.
 */
async function selectClaimCandidate(
  orgId: string,
  email: string | null,
): Promise<NativeCandidateRow | null> {
  const { emailHash } = computeContactHashes({ email, phone: null });
  if (!emailHash) return null;

  const [row] = await db
    .select({
      id: customers.id,
      fieldpulseCustomerId: customers.fieldpulseCustomerId,
    })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, orgId),
        eq(customers.emailHash, emailHash),
        sql.raw(NATIVE_CLAIM_CANDIDATE_FILTER_SQL),
      ),
    )
    .orderBy(asc(customers.createdAt), asc(customers.id))
    .limit(1);

  if (!row) return null;
  return {
    id: row.id,
    matchedOn: "email",
    fieldpulseCustomerId: row.fieldpulseCustomerId,
  };
}

/**
 * The guarded claim. Its predicate is the candidate SELECT's, term for term —
 * the shared constant PLUS the email-hash equality the candidate was selected
 * by: the phase runs for ~20 minutes and nothing pauses an operator, so a row
 * archived, blocked, or re-contacted in between must not be claimed.
 * Zero rows returned is a normal outcome, handled by the caller.
 */
async function claimNativeCustomer(
  orgId: string,
  customer: MappedFpCustomer,
  candidateId: string,
  fpSpillover: ReturnType<typeof buildFpSpillover>,
): Promise<string | null> {
  const { emailHash, phoneHash } = computeContactHashes({
    email: customer.email,
    phone: customer.phone,
  });
  // A claim is email-only by design (§2.1): reaching here without an email
  // hash means the caller's candidate search was broken — refuse rather than
  // claim on a predicate that would match rows by accident.
  if (!emailHash) return null;

  const claimed = await db
    .update(customers)
    .set({
      fieldpulseCustomerId: customer.fpId,
      nameEncrypted: encrypt(sanitizeName(customer.name)),
      emailEncrypted: customer.email ? encrypt(sanitizeEmail(customer.email)) : null,
      phoneEncrypted: customer.phone ? encrypt(sanitizePhone(customer.phone)) : null,
      addressEncrypted: customer.address ? encrypt(sanitizeAddress(customer.address)) : null,
      emailHash,
      phoneHash,
      fieldpulseCustomFields: customer.customFields ?? null,
      isTaxExempt: customer.isTaxExempt ?? null,
      billingAddressEncrypted: customer.billingAddress ? encrypt(sanitizeAddress(customer.billingAddress)) : null,
      fieldpulseData: fpSpillover,
      ...(customer.customerType ? { customerType: customer.customerType } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(customers.id, candidateId),
        eq(customers.organizationId, orgId),
        // The candidate was selected BY this email hash; requiring it again
        // here closes the SELECT→UPDATE window where a concurrent contact
        // edit changes the row's email — a claim is permanent and carries the
        // row's portal token, so it must only land on the row still holding
        // the email it was chosen for.
        eq(customers.emailHash, emailHash),
        sql.raw(NATIVE_CLAIM_CANDIDATE_FILTER_SQL),
      ),
    )
    .returning({ id: customers.id });

  return claimed[0]?.id ?? null;
}

/**
 * Step 4: a brand-new row for this FP customer, carrying whatever hashes exist.
 * On conflict (a concurrent run created it) re-select by fp id and return that,
 * so the caller never reads null as "unresolved" for a customer that has a row.
 */
async function insertFpCustomer(
  orgId: string,
  customer: MappedFpCustomer,
  fpSpillover: ReturnType<typeof buildFpSpillover>,
  counts?: PhaseResult,
): Promise<string | null> {
  const { emailHash, phoneHash } = computeContactHashes({
    email: customer.email,
    phone: customer.phone,
  });

  const [inserted] = await db
    .insert(customers)
    .values({
      organizationId: orgId,
      nameEncrypted: encrypt(sanitizeName(customer.name)),
      emailEncrypted: customer.email ? encrypt(sanitizeEmail(customer.email)) : null,
      phoneEncrypted: customer.phone ? encrypt(sanitizePhone(customer.phone)) : null,
      addressEncrypted: customer.address ? encrypt(sanitizeAddress(customer.address)) : null,
      emailHash,
      phoneHash,
      fieldpulseCustomerId: customer.fpId,
      fieldpulseCustomFields: customer.customFields ?? null,
      isTaxExempt: customer.isTaxExempt ?? null,
      billingAddressEncrypted: customer.billingAddress ? encrypt(sanitizeAddress(customer.billingAddress)) : null,
      fieldpulseData: fpSpillover,
      ...(customer.customerType ? { customerType: customer.customerType } : {}),
    })
    .onConflictDoNothing({
      target: [customers.organizationId, customers.fieldpulseCustomerId],
      // The unique index is PARTIAL — Postgres refuses the conflict target
      // unless the predicate matches (live-verified failure without this).
      where: isNotNull(customers.fieldpulseCustomerId),
    })
    .returning({ id: customers.id });

  if (inserted) {
    if (counts) counts.created++;
    return inserted.id;
  }

  const raced = await findByFpId(orgId, customer.fpId);
  if (counts) counts.skipped++;
  return raced?.id ?? null;
}

/**
 * Step 2: deleted/merged FP record — archived, contactless, keyed on the fp id.
 * Same insert as the legacy path (d) plus the SPEC §2.1 repair: a conflict miss
 * re-selects by fp id, so a null return means only "no row" and never "a row
 * already exists" — jobs.ts:424-428 skips the whole job on null.
 */
async function insertArchivedFpCustomer(
  orgId: string,
  customer: MappedFpCustomer,
  fpSpillover: ReturnType<typeof buildFpSpillover>,
  counts?: PhaseResult,
): Promise<string | null> {
  const { emailHash, phoneHash } = computeContactHashes({
    email: null,
    phone: null,
  });

  const [inserted] = await db
    .insert(customers)
    .values({
      organizationId: orgId,
      nameEncrypted: encrypt(sanitizeName(customer.name)),
      phoneEncrypted: null,
      emailEncrypted: null,
      addressEncrypted: customer.address ? encrypt(sanitizeAddress(customer.address)) : null,
      emailHash,
      phoneHash,
      fieldpulseCustomerId: customer.fpId,
      fieldpulseCustomFields: customer.customFields ?? null,
      isTaxExempt: customer.isTaxExempt ?? null,
      billingAddressEncrypted: customer.billingAddress ? encrypt(sanitizeAddress(customer.billingAddress)) : null,
      fieldpulseData: fpSpillover,
      archivedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [customers.organizationId, customers.fieldpulseCustomerId],
      where: isNotNull(customers.fieldpulseCustomerId),
    })
    .returning({ id: customers.id });

  if (inserted) {
    if (counts) {
      counts.created++;
      counts.archivedImported = (counts.archivedImported ?? 0) + 1;
    }
    return inserted.id;
  }

  const raced = await findByFpId(orgId, customer.fpId);
  if (counts) counts.skipped++;
  return raced?.id ?? null;
}

/**
 * Belt-and-braces for the flagged run (SPEC §2.0): refuse to split while the
 * legacy per-org contact uniques still exist. Runs at PHASE level, before the
 * walk — never inside importOneFpCustomer's per-record try/catch, where a throw
 * would be absorbed into counts.errors and the walk would continue. The throw
 * reaches run-import's phase handler → run `failed`, exit 1.
 */
export async function assertLegacyContactUniquesDropped(orgId: string): Promise<void> {
  const result = await db.execute(sql`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'customers'
      AND indexname IN (${LEGACY_CONTACT_UNIQUE_INDEXES[0]}, ${LEGACY_CONTACT_UNIQUE_INDEXES[1]})
  `);
  // neon-http returns a result object with `.rows`; other drivers return the
  // array itself. Accept both rather than assuming (precedent: signals.ts).
  const raw = result as unknown;
  const rows = ((raw as { rows?: unknown[] }).rows ??
    (raw as unknown[])) as readonly { indexname?: string | null }[];

  if (shouldAbortForLegacyContactUniques(rows)) {
    throw new Error(
      "--split-shared-contacts refused: the legacy per-org contact unique indexes are still present. " +
        "Apply the migration that drops them before running the split, or re-run without the flag.",
    );
  }

  logger.info(
    { orgId },
    "FP customers import: --split-shared-contacts enabled — legacy contact uniques confirmed absent",
  );
}
