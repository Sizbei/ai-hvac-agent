/**
 * Phase 3 — FieldPulse customers inbound pull.
 *
 * importCustomersFromFieldpulse pages the full /customers list and upserts each
 * active record into the native customers table, linking by fieldpulseCustomerId.
 *
 * Resolution order per record:
 *  a) Existing row with matching fieldpulseCustomerId → UPDATE contact fields.
 *  b) Record has email or phone → upsertCustomerByContact (HMAC-dedupe) → set
 *     fieldpulseCustomerId on the returned id, guarded against the per-org unique
 *     index so we never clobber another row that already owns the fpId.
 *  c) Contactless (no email, no phone) → insert keyed purely on fieldpulseCustomerId
 *     via onConflictDoNothing on the partial unique index.
 *  d) Deleted/merged FP records → inserted as ARCHIVED (archivedAt set), keyed
 *     on fieldpulseCustomerId via the contactless path. This makes the orphaned
 *     jobs importable without un-archiving or merging into active native customers.
 *     These records are deliberately NOT routed through upsertCustomerByContact
 *     because that function would un-archive a returning customer on contact match.
 *
 * With --split-shared-contacts (opt-in per run, never the nightly sweep) the
 * whole order above is replaced by the per-FP-customer split: fp id → archived
 * import → claim a native row on the email blind index → insert unconditionally.
 * See importSplitFpCustomer in customer-split.ts.
 *
 * Known limitations (documented, not silent):
 *  - created/updated split for path (b) is approximate: upsertCustomerByContact
 *    returns only the id; we count as 'created' (the common case for the initial
 *    backfill). A row that already existed before this import run is treated the
 *    same way — the count slightly over-reports created vs updated. This is
 *    accepted for the foundation pass.
 *  - Contactless-FP-customer duplicates: a bot booking by the same human (who
 *    later provides a phone) creates a separate row that the dedupe can't see.
 *    Mitigation = later reconciliation pass (name+address match → suggest merge).
 */
import { eq, and, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
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
import {
  upsertCustomerByContact,
  normalizeEmail,
  normalizePhone,
  computeContactHashes,
} from "@/lib/admin/crm-queries";
import type { FieldpulseClient } from "../client";
import type { FieldpulseCustomer } from "../types";
import type { PhaseResult } from "./run-import";
import { buildFpSpillover } from "./spillover";
import { keepEarliest } from "./keep-earliest";
import { parseFpDate } from "../fp-dates";
import {
  assertLegacyContactUniquesDropped,
  importSplitFpCustomer,
} from "./customer-split";

// ── Mapper ────────────────────────────────────────────────────────────────────

export interface MappedFpCustomer {
  readonly fpId: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  readonly customFields: { name: string; value: string }[] | null;
  // P1 field-parity additions.
  readonly customerType: "residential" | "commercial" | null;
  readonly isTaxExempt: boolean | null;
  readonly billingAddress: string | null;
  /** FP's own created_at; NULL when FP sent none. */
  readonly createdAt: Date | null;
}

/**
 * Skip reason for records that must not be imported.
 * Returned instead of a MappedFpCustomer when the record should be skipped.
 */
export type SkipReason = "unnamed";

export type MapResult =
  | { readonly ok: true; readonly customer: MappedFpCustomer; readonly archivedImport: boolean }
  | { readonly ok: false; readonly reason: SkipReason };

/**
 * Pure mapper: raw FieldpulseCustomer → MappedFpCustomer or a skip classification.
 *
 * Name priority: display_name → first_name + last_name → company_name.
 * Phone priority: phone_e164 → phone → (nothing).
 * Address: compose address_1[, address_2], city, state zip_code (skips empty parts).
 */
export function mapFpCustomer(fp: FieldpulseCustomer): MapResult {
  // Deleted/merged: import as archived to allow orphaned jobs to be imported.
  // These are kept distinct from active customers — never contact-dedupe-merged.
  const archivedImport = fp.deletedAt != null || fp.mergedCustomerId != null;

  // Name resolution (required even for archived records).
  const name = resolveName(fp);
  if (!name) {
    return { ok: false, reason: "unnamed" };
  }

  // Email: lowercase-trim or null.
  const email = normalizeEmail(fp.email ?? null);

  // Phone: prefer E.164 (already normalized), fall back to raw phone.
  const rawPhone =
    fp.phoneE164 != null && fp.phoneE164.trim().length > 0
      ? fp.phoneE164.trim()
      : fp.phone != null && fp.phone.trim().length > 0
        ? fp.phone.trim()
        : null;
  const phone = rawPhone ? normalizePhone(rawPhone) : null;

  // Address: compose from flat fields, skipping empty parts.
  const address = composeAddress(fp);

  // P1: customerType — map FP account_type into the existing enum.
  // Decision (2026-07-11): the sanitized fixture has no account_type field.
  // We map "residential"/"commercial" directly; anything else → null (use default).
  // No separate account_type column added (enum covers known values).
  const customerType = mapAccountType(fp.accountType ?? null);

  // P1: is_tax_exempt — pass through as-is.
  const isTaxExempt = fp.isTaxExempt ?? null;

  // P1: billing address — compose only when the client surfaced it.
  // has_different_billing_address was NOT present in the sanitized fixture (2026-07-11);
  // the client gates on it and populates billingAddress only when the flag is truthy.
  const billingAddress = composeBillingAddress(fp);

  return {
    ok: true,
    archivedImport,
    customer: {
      fpId: fp.id,
      name,
      email,
      phone,
      address,
      customFields: fp.customFields ? [...fp.customFields] : null,
      customerType,
      isTaxExempt,
      billingAddress,
      createdAt: parseFpDate(fp.createdAt),
    },
  };
}

/**
 * Map FP `account_type` string to the native customerTypeEnum.
 * Live FieldPulse sends "company" or "individual" (2026-11-11 census: 2,099
 * company, 533 individual, 24 absent); "commercial"/"residential" are accepted
 * too. Anything else (including null/unknown) returns null → importer keeps
 * the existing value without overwriting it.
 */
export function mapAccountType(raw: string | null): "residential" | "commercial" | null {
  if (!raw) return null;
  const s = raw.toLowerCase().trim();
  if (s === "residential" || s === "individual") return "residential";
  if (s === "commercial" || s === "company") return "commercial";
  return null; // unknown value — keep default
}

/** Insert values: FieldPulse's own created date when it sent one. */
export function fpCreatedAtValues(customer: MappedFpCustomer): { createdAt?: Date } {
  return customer.createdAt ? { createdAt: customer.createdAt } : {};
}

/** Update set: move created_at back to FieldPulse's date, never forward. */
export function fpCreatedAtSet(customer: MappedFpCustomer): { createdAt?: SQL } {
  return customer.createdAt ? { createdAt: keepEarliest(customers.createdAt, customer.createdAt) } : {};
}

function composeBillingAddress(fp: FieldpulseCustomer): string | null {
  const addr = fp.billingAddress;
  if (!addr) return null;

  const parts: string[] = [];
  const street = addr.street?.trim();
  const street2 = addr.streetLine2?.trim();
  const city = addr.city?.trim();
  const state = addr.state?.trim();
  const zip = addr.zip?.trim();

  if (street) parts.push(street);
  if (street2) parts.push(street2);

  const cityStateZip = [city, state && zip ? `${state} ${zip}` : state ?? zip]
    .filter(Boolean)
    .join(", ");
  if (cityStateZip) parts.push(cityStateZip);

  return parts.length > 0 ? parts.join(", ") : null;
}

function resolveName(fp: FieldpulseCustomer): string | null {
  // display_name is present on ALL Phase-0.5-verified rows.
  const displayName = fp.displayName?.trim();
  if (displayName) return displayName;

  // Fallback: assemble from first + last name.
  const firstName = fp.firstName?.trim();
  const lastName = fp.lastName?.trim();
  const assembled = [firstName, lastName].filter(Boolean).join(" ");
  if (assembled) return assembled;

  // Final fallback: company name.
  const company = fp.company?.trim();
  if (company) return company;

  return null;
}

function composeAddress(fp: FieldpulseCustomer): string | null {
  // The raw FieldpulseCustomer carries the flat fields via the address object
  // (mapped by toCustomer from address_1/address_2/city/state/zip_code).
  const addr = fp.address;
  if (!addr) return null;

  const parts: string[] = [];
  const street = addr.street?.trim();
  const street2 = addr.streetLine2?.trim();
  const city = addr.city?.trim();
  const state = addr.state?.trim();
  const zip = addr.zip?.trim();

  if (street) parts.push(street);
  if (street2) parts.push(street2);

  // city, state zip_code on one segment.
  const cityStateZip = [city, state && zip ? `${state} ${zip}` : state ?? zip]
    .filter(Boolean)
    .join(", ");
  if (cityStateZip) parts.push(cityStateZip);

  return parts.length > 0 ? parts.join(", ") : null;
}

// ── Importer ─────────────────────────────────────────────────────────────────

/**
 * Options for the opt-in per-FP-customer split (SPEC §2.0).
 *
 * OPTIONAL by design: the jobs-phase self-heal (`jobs.ts:389`) calls
 * importOneFpCustomer with two arguments and no map, and must keep working
 * unchanged — it heals one customer at a time, so the default (legacy,
 * non-splitting) behaviour is the correct one for it.
 */
export interface ImportFpCustomerOptions {
  /** Run SPEC §2.1's resolution instead of the legacy path. */
  readonly splitSharedContacts?: boolean;
  /** Per-run map of claimed native candidate id → the fp id that claimed it. */
  readonly claimedThisRun?: Map<string, string>;
}

/**
 * Import a single FieldPulse customer record into the native customers table.
 * Shared by the full walk and the jobs-importer customer self-heal.
 *
 * Legacy (default, unflagged) resolution paths — what the nightly sweep runs:
 *  a) Existing row with matching fieldpulseCustomerId → UPDATE contact fields.
 *  b) Record has email or phone → upsertCustomerByContact (HMAC-dedupe) → set
 *     fieldpulseCustomerId on the returned id, guarded against the per-org unique
 *     index so we never clobber another row that already owns the fpId.
 *  c) Contactless (no email, no phone) → insert keyed purely on fieldpulseCustomerId.
 *  d) Deleted/merged FP records → inserted as ARCHIVED (archivedAt set).
 *
 * With `opts.splitSharedContacts` the whole resolution is replaced by SPEC
 * §2.1's order (fp id → archived import → claim a native row on email →
 * unconditional insert), which is the behaviour that gives every FP customer
 * its own row. The flag selects between two WHOLE paths, not two outcomes
 * inside one path: the flagged path never routes through
 * upsertCustomerByContact (that function un-archives a matched row and creates
 * one on a miss).
 *
 * Mutates `counts` in-place when provided (optional so callers can omit it).
 * Returns the native customer id on success, null on skip/error.
 */
export async function importOneFpCustomer(
  orgId: string,
  fp: FieldpulseCustomer,
  counts?: PhaseResult,
  opts?: ImportFpCustomerOptions,
): Promise<string | null> {
  const mapped = mapFpCustomer(fp);
  if (!mapped.ok) {
    if (counts) counts.skipped++;
    return null;
  }

  const { customer, archivedImport } = mapped;

  try {
    // Build customer spillover (strict ALLOWLIST — no PII in jsonb).
    // fp._raw is the raw FP API payload threaded through toCustomer(); the
    // ALLOWLIST in buildFpSpillover guarantees only safe, non-PII keys survive.
    const fpSpillover = buildFpSpillover(fp._raw ?? {}, "customers");

    // Path (a): existing row keyed on fieldpulseCustomerId.
    const existing = await findByFpId(orgId, customer.fpId);

    if (opts?.splitSharedContacts) {
      return await importSplitFpCustomer(orgId, customer, {
        archivedImport,
        fpSpillover,
        existing,
        counts,
        claimedThisRun: opts.claimedThisRun,
      });
    }

    if (existing) {
      // ERASURE IS NOT REVERSIBLE BY A SYNC. Anonymizing a customer scrubs the
      // encrypted name/phone/email/address and the blind indexes, but leaves
      // fieldpulseCustomerId in place — so without this guard the next sweep
      // finds the row by fp id and writes every field back from FieldPulse,
      // re-encrypting the exact PII the person asked us to delete. Worse, it
      // does so while `anonymizedAt` stays set, so a compliance check that
      // looks for "anonymizedAt IS NOT NULL" reports the record as erased
      // while it holds full PII again. Skip the row and leave it erased.
      if (existing.anonymizedAt) {
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

    // Path (d): archived import (deleted/merged FP records).
    // NEVER route through upsertCustomerByContact — that function un-archives
    // on contact match, which would reactivate an archived native customer.
    // Use the fpId-keyed contactless insert path with archivedAt set instead.
    if (archivedImport) {
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
          ...(customer.customerType ? { customerType: customer.customerType } : {}),
          ...fpCreatedAtValues(customer),
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
      } else {
        if (counts) counts.skipped++;
        return null;
      }
    }

    if (customer.email || customer.phone) {
      // Path (b): dedupe via HMAC blind-index → upsertCustomerByContact.
      const nativeId = await upsertCustomerByContact(orgId, {
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        address: customer.address,
      });

      // Guard: set fieldpulseCustomerId only if the returned row doesn't already
      // own a different fpId. The partial unique index enforces this at the DB
      // layer (unique per org), but we guard the UPDATE to avoid a silent no-op
      // overwrite in the unlikely case of a race (e.g. a concurrent import run).
      const updated = await db
        .update(customers)
        .set({
          fieldpulseCustomerId: customer.fpId,
          fieldpulseCustomFields: customer.customFields ?? null,
          isTaxExempt: customer.isTaxExempt ?? null,
          billingAddressEncrypted: customer.billingAddress ? encrypt(sanitizeAddress(customer.billingAddress)) : null,
          fieldpulseData: fpSpillover,
          ...(customer.customerType ? { customerType: customer.customerType } : {}),
          ...fpCreatedAtSet(customer),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(customers.id, nativeId),
            eq(customers.organizationId, orgId),
            sql`(${customers.fieldpulseCustomerId} IS NULL OR ${customers.fieldpulseCustomerId} = ${customer.fpId})`,
          ),
        )
        .returning({ id: customers.id });

      if (updated.length === 0) {
        // The contact-matched native row already owns a DIFFERENT fpId — this
        // FP record is a duplicate person in FieldPulse (live-verified: the 12
        // orphan jobs' customers are contact-dupes of already-imported rows).
        // The fpId LINK is refused (never clobber), but the resolved native id
        // is still THE person — return it so callers (the jobs self-heal) can
        // attach dependent records to the right customer.
        logger.warn(
          { orgId, fpId: customer.fpId, nativeId },
          "FP customer: fpId guard prevented overwrite — linking skipped, resolved to existing row",
        );
        if (counts) {
          counts.skipped++;
          // The ONLY behavioural addition on the unflagged path (SPEC §2.0):
          // count the FP customers awaiting a split, so the nightly run reports
          // how many there are without changing a single outcome. The return
          // value stays the resolved native id — jobs.ts:424-428 skips the
          // WHOLE job on null, so a null here would silently drop jobs nightly.
          counts.sharedContactSkipped = (counts.sharedContactSkipped ?? 0) + 1;
        }
        return nativeId;
      } else {
        // Note: created/updated distinction is approximate here — we can't
        // cheaply tell from upsertCustomerByContact whether the row pre-existed.
        // Counted as 'created' (most common case for backfill). A pre-existing
        // native match is also counted as 'created'; the shortfall vs 'updated'
        // is documented in the module header.
        if (counts) counts.created++;
        return nativeId;
      }
    }

    // Path (c): contactless — insert keyed purely on fieldpulseCustomerId.
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
        ...(customer.customerType ? { customerType: customer.customerType } : {}),
        ...fpCreatedAtValues(customer),
      })
      .onConflictDoNothing({
        target: [customers.organizationId, customers.fieldpulseCustomerId],
        // The unique index is PARTIAL (WHERE fieldpulse_customer_id IS NOT
        // NULL); Postgres refuses the conflict target unless the predicate
        // matches — live-verified failure without this on 2026-07-09.
        where: isNotNull(customers.fieldpulseCustomerId),
      })
      .returning({ id: customers.id });

    if (inserted) {
      if (counts) counts.created++;
      return inserted.id;
    } else {
      // Row already existed for this fpId (re-run).
      if (counts) counts.skipped++;
      return null;
    }
  } catch (err) {
    // Per-record errors must never abort the walk — log with fpId and continue.
    if (counts) counts.errors++;
    logger.error(
      {
        orgId,
        fpId: customer.fpId,
        error: err instanceof Error ? err.message : String(err),
      },
      "FP customer import: per-record error (continuing)",
    );
    return null;
  }
}

/**
 * Consecutive heal failures before the breaker opens. `getCustomer` only throws
 * when FieldPulse is unreachable, so a short run of throws means the API is
 * down, not that these particular customers are unusual.
 */
const HEAL_FAILURE_LIMIT = 5;

/**
 * SELECT-only resolution of a FieldPulse customer to a native row, keyed on the
 * email blind index. No writes, by design — see makeFpCustomerHealer.
 */
async function resolveNativeCustomerByEmail(
  orgId: string,
  fp: FieldpulseCustomer,
): Promise<string | null> {
  const mapped = mapFpCustomer(fp);
  if (!mapped.ok) return null;

  const { emailHash } = computeContactHashes({
    email: mapped.customer.email,
    phone: null,
  });
  if (!emailHash) return null;

  const [row] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, orgId),
        eq(customers.emailHash, emailHash),
        // THE ROW MUST NOT ALREADY BE SOMEONE ELSE. A shared email does not
        // mean a shared identity: in this operator's live data a single
        // accounts-payable address covers up to 21 unrelated businesses,
        // because third-party AP desks, warranty administrators and property
        // managers pay invoices on behalf of many customers. Contact dedupe
        // collapses all of them onto one native row, and the first fp id to
        // arrive wins the link. Matching on email alone would therefore file
        // one company's invoices under another company's name — and since
        // that row drives the customer portal, it would show them there too.
        //
        // So the heal only fires when the matched row carries no FieldPulse
        // identity of its own (a native/bot-created customer, or one lost to a
        // list-pagination gap), or when it is already this exact customer.
        // For a collapsed group it deliberately does nothing: those invoices
        // stay visibly unlinked, which is the honest state. The real repair
        // there is at the customer level — give each FieldPulse customer its
        // own row — not at the invoice level.
        //
        // Never re-attach live money to a record someone asked us to erase.
        isNull(customers.anonymizedAt),
        sql`(${customers.fieldpulseCustomerId} IS NULL OR ${customers.fieldpulseCustomerId} = ${mapped.customer.fpId})`,
      ),
    )
    .limit(1);

  return row?.id ?? null;
}

/**
 * Builds a cached, READ-ONLY "resolve this FP customer id to a native customer"
 * function.
 *
 * WHY THIS EXISTS: a strict `fieldpulseCustomerId` lookup misses whenever the
 * fp id was never written onto any row, and every miss orphans the dependent
 * record permanently. The live cause is commercial customers: several sibling
 * sites of one franchise share a single billing email and phone, so contact
 * dedupe collapses them onto one native row. The first fp id wins the link and
 * the fpId guard above then refuses to overwrite it for the siblings — rightly,
 * it must never clobber — so those fp ids exist on no row at all, forever.
 *
 * WHY IT ONLY READS. The obvious implementation delegates to
 * `importOneFpCustomer`, which resolves the same merged row. It also writes:
 * it can insert a customer, un-archive one (`upsertCustomerByContact` clears
 * `archivedAt` on a contact match — the hazard called out at path (d) above),
 * null-clobber `isTaxExempt`/`billingAddress`/`customFields` when the FP
 * payload omits them, and re-encrypt PII onto a row that GDPR erasure had
 * scrubbed. None of that is needed to answer "which customer is this invoice
 * for", and one caller is an inbound webhook — so that version would let a
 * third-party HTTP request create and mutate customer records. This one runs a
 * single SELECT and returns an id.
 *
 * WHY EMAIL ONLY. The link it produces is an authorization boundary, not just
 * a display convenience: the collections flow mints a portal token from
 * `invoices.customerId`, and the portal lists every invoice on that row. Phone
 * numbers collide between unrelated people (an office line, a property
 * manager, a placeholder a dispatcher typed), so a phone-only match could hand
 * one customer another's invoices. A shared email is far stronger evidence of
 * a genuinely shared billing identity. Refusing phone-only matches means some
 * invoices stay unlinked — the honest failure, and the one that cannot leak.
 *
 * Anonymized rows are excluded: an erased customer must not be silently
 * re-attached to live money.
 *
 * Returns null when FP 404s the id (HARD-DELETED), when the customer has no
 * email, or when no row matches. Callers decide what that means for their
 * record — invoices leave the link null rather than invent a placeholder,
 * because you cannot collect from a deleted customer and a fabricated link
 * would only hide that.
 *
 * The cache is per-factory-call (i.e. per run/request) so a sweep touching 500
 * invoices that share 20 customers issues 20 fetches, not 500.
 */
export function makeFpCustomerHealer(
  orgId: string,
  client: Pick<FieldpulseClient, "getCustomer">,
  counts?: PhaseResult,
): (fpCustomerId: string) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  let consecutiveFailures = 0;
  let trippedLogged = false;

  return async (fpCustomerId: string): Promise<string | null> => {
    const cached = cache.get(fpCustomerId);
    if (cached !== undefined) return cached;

    // Circuit breaker. `getCustomer` only throws when FieldPulse is unreachable
    // (404 comes back as a clean null), so a run of throws means the API is
    // down — not that these customers are special. Without this, a sweep of
    // ~2,900 invoices would keep retrying into a dead endpoint, three attempts
    // and up to 45s apiece, and take hours to admit defeat.
    if (consecutiveFailures >= HEAL_FAILURE_LIMIT) {
      if (!trippedLogged) {
        trippedLogged = true;
        // Count it once, so the phase ledger cannot report a clean run while
        // every remaining invoice is silently written without a customer.
        if (counts) counts.errors++;
        logger.error(
          { orgId, consecutiveFailures },
          "FP customer heal: too many consecutive failures — healing disabled for the rest of this run; links will be missing until the next run",
        );
      }
      return null;
    }

    let healed: string | null = null;
    try {
      const fpCustomer = await client.getCustomer(fpCustomerId);
      consecutiveFailures = 0;
      healed = fpCustomer ? await resolveNativeCustomerByEmail(orgId, fpCustomer) : null;
    } catch (err) {
      // A heal failure must never fail the record it was helping — the caller
      // still writes the row, just without the link.
      consecutiveFailures++;
      logger.warn(
        {
          orgId,
          fpCustomerId,
          error: err instanceof Error ? err.message : String(err),
        },
        "FP customer heal failed (continuing without the link)",
      );
      // Deliberately NOT cached. A transient failure is not evidence about this
      // customer, and caching it would make one blip permanent for the whole
      // run — the same conflation of "absent" with "unreachable" that this
      // function exists to avoid. The breaker above bounds the retries instead.
      return null;
    }

    cache.set(fpCustomerId, healed);
    return healed;
  };
}

/**
 * Placeholder for a customer that is HARD-DELETED in FieldPulse (absent from
 * the list walk AND 404 on per-id fetch — live-verified 2026-07-09: six such
 * customers own ten real calendar jobs, incl. future ones). The jobs must land
 * on the calendar, so we key an ARCHIVED, contactless placeholder on the dead
 * fp id; future runs resolve it instantly via the fpId path. Idempotent.
 */
export async function createDeletedPlaceholderCustomer(
  orgId: string,
  fpCustomerId: string,
): Promise<string | null> {
  const [inserted] = await db
    .insert(customers)
    .values({
      organizationId: orgId,
      nameEncrypted: encrypt(sanitizeName(`FieldPulse customer (deleted #${fpCustomerId})`)),
      phoneEncrypted: null,
      emailEncrypted: null,
      addressEncrypted: null,
      emailHash: null,
      phoneHash: null,
      fieldpulseCustomerId: fpCustomerId,
      archivedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [customers.organizationId, customers.fieldpulseCustomerId],
      where: isNotNull(customers.fieldpulseCustomerId),
    })
    .returning({ id: customers.id });
  if (inserted) return inserted.id;
  // Re-run: the placeholder already exists — resolve it.
  const existing = await findByFpId(orgId, fpCustomerId);
  return existing?.id ?? null;
}

export async function importCustomersFromFieldpulse(
  orgId: string,
  counts: PhaseResult,
  client: FieldpulseClient,
  opts?: { readonly splitSharedContacts?: boolean },
): Promise<void> {
  const splitSharedContacts = opts?.splitSharedContacts === true;
  // Pre-flight, before anything is fetched or written: running the split
  // against the pre-migration schema is an error storm, not a partial success.
  if (splitSharedContacts) await assertLegacyContactUniquesDropped(orgId);

  // Contested candidates are never claimed (SPEC §2.1): FP list order carries
  // no identity meaning, so the second FP customer to select an
  // already-claimed-this-run candidate inserts its own row instead.
  const claimedThisRun = new Map<string, string>();

  // Walk the full customer list.
  const { items, totalCount, cappedByMaxPages } = await client.listCustomers();
  counts.fetched = items.length;
  // Signal total to the live status page.
  counts.total = totalCount ?? null;

  if (cappedByMaxPages) {
    logger.warn(
      {
        orgId,
        fetched: items.length,
        note: "Walk exhausted maxPages on a full page — possible truncation; raise maxPages or investigate",
      },
      "FP customers import: walk may be incomplete (cappedByMaxPages=true)",
    );
    (counts as unknown as Record<string, unknown>).cappedNote = "cappedByMaxPages";
  }

  // Warn if the walk didn't reach the expected total_count (partial walk).
  if (totalCount !== null && items.length < totalCount) {
    logger.warn(
      {
        orgId,
        fetched: items.length,
        totalCount,
        shortfall: totalCount - items.length,
      },
      "FP customer pull: fetched fewer rows than total_count — possible partial walk; check maxPages",
    );
  }

  for (const fp of items) {
    await importOneFpCustomer(
      orgId,
      fp,
      counts,
      splitSharedContacts ? { splitSharedContacts, claimedThisRun } : undefined,
    );
  }
}

// ── DB helpers (org-scoped) ───────────────────────────────────────────────────

export async function findByFpId(
  orgId: string,
  fpId: string,
): Promise<{ id: string; anonymizedAt: Date | null } | null> {
  const [row] = await db
    .select({ id: customers.id, anonymizedAt: customers.anonymizedAt })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, orgId),
        eq(customers.fieldpulseCustomerId, fpId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function updateCustomerFields(
  orgId: string,
  customerId: string,
  customer: MappedFpCustomer,
  fpSpillover: ReturnType<typeof buildFpSpillover> = null,
): Promise<void> {
  const { emailHash, phoneHash } = computeContactHashes({
    email: customer.email,
    phone: customer.phone,
  });

  await db
    .update(customers)
    .set({
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
      ...fpCreatedAtSet(customer),
      updatedAt: new Date(),
    })
    .where(
      and(eq(customers.id, customerId), eq(customers.organizationId, orgId)),
    );
}

