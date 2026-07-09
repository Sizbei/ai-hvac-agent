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
import { eq, and, isNotNull, sql } from "drizzle-orm";
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

// ── Mapper ────────────────────────────────────────────────────────────────────

export interface MappedFpCustomer {
  readonly fpId: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  readonly customFields: { name: string; value: string }[] | null;
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
    },
  };
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
 * Import a single FieldPulse customer record into the native customers table.
 * Shared by the full walk and the jobs-importer customer self-heal.
 *
 * Resolution paths:
 *  a) Existing row with matching fieldpulseCustomerId → UPDATE contact fields.
 *  b) Record has email or phone → upsertCustomerByContact (HMAC-dedupe) → set
 *     fieldpulseCustomerId on the returned id, guarded against the per-org unique
 *     index so we never clobber another row that already owns the fpId.
 *  c) Contactless (no email, no phone) → insert keyed purely on fieldpulseCustomerId.
 *  d) Deleted/merged FP records → inserted as ARCHIVED (archivedAt set).
 *
 * Mutates `counts` in-place when provided (optional so callers can omit it).
 * Returns the native customer id on success, null on skip/error.
 */
export async function importOneFpCustomer(
  orgId: string,
  fp: FieldpulseCustomer,
  counts?: PhaseResult,
): Promise<string | null> {
  const mapped = mapFpCustomer(fp);
  if (!mapped.ok) {
    if (counts) counts.skipped++;
    return null;
  }

  const { customer, archivedImport } = mapped;

  try {
    // Path (a): existing row keyed on fieldpulseCustomerId.
    const existing = await findByFpId(orgId, customer.fpId);
    if (existing) {
      await updateCustomerFields(orgId, existing.id, customer);
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
        .set({ fieldpulseCustomerId: customer.fpId, fieldpulseCustomFields: customer.customFields ?? null, updatedAt: new Date() })
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
        if (counts) counts.skipped++;
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
): Promise<void> {
  // Walk the full customer list.
  const { items, totalCount } = await client.listCustomers();
  counts.fetched = items.length;
  // Signal total to the live status page.
  counts.total = totalCount ?? null;

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
    await importOneFpCustomer(orgId, fp, counts);
  }
}

// ── DB helpers (org-scoped) ───────────────────────────────────────────────────

async function findByFpId(
  orgId: string,
  fpId: string,
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: customers.id })
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

async function updateCustomerFields(
  orgId: string,
  customerId: string,
  customer: MappedFpCustomer,
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
      updatedAt: new Date(),
    })
    .where(
      and(eq(customers.id, customerId), eq(customers.organizationId, orgId)),
    );
}

