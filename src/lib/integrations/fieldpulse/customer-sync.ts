/**
 * CUSTOMER SYNC: mirror one of our CRM customers into Fieldpulse and remember
 * the mapping (customers.fieldpulse_customer_id).
 *
 * Mirrors housecall-pro/customer-sync.ts: called from route `after()` background
 * tasks — NEVER on the response path. The golden rule is DEGRADE SAFELY: every
 * path no-ops (logging at most a warning) when the org isn't Fieldpulse-connected,
 * the customer doesn't exist, or Fieldpulse returns an error.
 *
 * IDEMPOTENT: once customers.fieldpulse_customer_id is set, a re-sync no-ops.
 * Before creating, we ask Fieldpulse's own lookup (find-by email/phone) so we
 * don't create a duplicate Fieldpulse customer for one that already exists there.
 *
 * The API key is never logged; PII is decrypted only in memory for the FP body.
 */
import { eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { getFieldpulseClient } from "./client";
import type {
  FieldpulseAddress,
  CreateCustomerInput,
  FindCustomerQuery,
} from "./types";

/** Decrypt-or-null without throwing on tampered/garbage ciphertext. */
function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) {
    return null;
  }
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** Placeholder Fieldpulse last name when our single `name` field has no surname. */
const FIELDPULSE_UNKNOWN_LAST_NAME = "Customer";

/**
 * Split our single `name` field into Fieldpulse's first/last. Fieldpulse
 * may require a last name; a single-token name (or empty) is sent as first +
 * a placeholder last so the create never fails on a missing surname.
 */
export function splitName(fullName: string | null): {
  readonly firstName: string;
  readonly lastName: string;
} {
  const trimmed = (fullName ?? "").trim();
  if (trimmed.length === 0) {
    return { firstName: "Unknown", lastName: FIELDPULSE_UNKNOWN_LAST_NAME };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0]!, lastName: FIELDPULSE_UNKNOWN_LAST_NAME };
  }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1]!,
  };
}

/** Our decrypted customer fields, used to build the Fieldpulse create payload. */
interface CustomerContact {
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
}

/**
 * Build the Fieldpulse create-customer payload from our decrypted contact. We
 * carry the free-text address into Fieldpulse's `street` field — Fieldpulse
 * accepts a loosely-structured address and we don't parse it into components.
 */
function toCreateInput(contact: CustomerContact): CreateCustomerInput {
  const { firstName, lastName } = splitName(contact.name);
  const address: FieldpulseAddress | undefined = contact.address
    ? { street: contact.address }
    : undefined;
  return {
    firstName,
    lastName,
    email: contact.email ?? undefined,
    phone: contact.phone ?? undefined,
    address,
  };
}

/** Build Fieldpulse's find query from our contact (email preferred, phone fallback). */
function toFindQuery(contact: CustomerContact): FindCustomerQuery | null {
  if (contact.email) {
    return { email: contact.email };
  }
  if (contact.phone) {
    return { phone: contact.phone };
  }
  return null;
}

/** Case-insensitive email compare; both sides trimmed. */
function emailsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) {
    return false;
  }
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Digits-only phone compare so formatting differences don't block a match. */
function phonesMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) {
    return false;
  }
  const digits = (s: string): string => s.replace(/\D/g, "");
  const da = digits(a);
  const db = digits(b);
  return da.length > 0 && da === db;
}

/**
 * Verify that a Fieldpulse customer candidate exactly matches our contact.
 * Fieldpulse's search may be fuzzy; we only reuse a candidate that EXACTLY matches
 * our email/phone to avoid a wrong mapping.
 */
function isExactMatch(
  contact: CustomerContact,
  candidate: { readonly email: string | null; readonly phone: string | null },
): boolean {
  if (emailsMatch(contact.email, candidate.email)) {
    return true;
  }
  return phonesMatch(contact.phone, candidate.phone);
}

/**
 * Mirror our customer into Fieldpulse and persist the resulting Fieldpulse id on
 * our row. Best-effort + idempotent:
 *
 *  - No-ops when the org isn't Fieldpulse-connected (no client) or the customer
 *    doesn't exist in the org.
 *  - No-ops when customers.fieldpulse_customer_id is already set (already
 *    mapped).
 *  - Otherwise: ask Fieldpulse to find an existing customer by email/phone first
 *    (avoids duplicate Fieldpulse records); only create when none is found.
 *  - Stores the Fieldpulse id with a guard (... AND fieldpulse_customer_id IS NULL)
 *    so two concurrent syncs can't clobber each other.
 *
 * Any Fieldpulse/network error is logged at WARN and swallowed — never thrown.
 * `fetchImpl` is injectable so tests mock the network and never hit the real API.
 */
export async function syncCustomerToFieldpulse(
  organizationId: string,
  customerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const client = await getFieldpulseClient(organizationId, fetchImpl);
  if (!client) {
    return; // org not Fieldpulse-connected — safe no-op
  }

  try {
    const [row] = await db
      .select({
        id: customers.id,
        fieldpulseCustomerId: customers.fieldpulseCustomerId,
        nameEncrypted: customers.nameEncrypted,
        emailEncrypted: customers.emailEncrypted,
        phoneEncrypted: customers.phoneEncrypted,
        addressEncrypted: customers.addressEncrypted,
      })
      .from(customers)
      .where(
        withTenant(customers, organizationId, eq(customers.id, customerId)),
      );

    if (!row) {
      return; // unknown customer — nothing to sync
    }
    if (row.fieldpulseCustomerId) {
      return; // already mapped — idempotent no-op
    }

    const contact: CustomerContact = {
      name: safeDecrypt(row.nameEncrypted),
      email: safeDecrypt(row.emailEncrypted),
      phone: safeDecrypt(row.phoneEncrypted),
      address: safeDecrypt(row.addressEncrypted),
    };

    // Find-or-create against Fieldpulse. Prefer an existing Fieldpulse customer
    // (by email, else phone) to avoid duplicates; create only when none matches.
    const findQuery = toFindQuery(contact);
    const candidate = findQuery ? await client.findCustomer(findQuery) : null;
    const existing =
      candidate && isExactMatch(contact, candidate) ? candidate : null;
    const fpId = existing
      ? existing.id
      : (await client.createCustomer(toCreateInput(contact))).id;

    // Persist the mapping, guarded on fieldpulse_customer_id IS NULL so a racing
    // sync that already wrote an id is never overwritten.
    await db
      .update(customers)
      .set({ fieldpulseCustomerId: fpId, updatedAt: new Date() })
      .where(
        withTenant(
          customers,
          organizationId,
          eq(customers.id, customerId),
          isNull(customers.fieldpulseCustomerId),
        ),
      );

    logger.info(
      { organizationId, customerId, created: existing === null },
      "Synced customer to Fieldpulse",
    );
  } catch (error: unknown) {
    // Degrade: a Fieldpulse failure must not surface to the booking flow.
    logger.warn(
      { organizationId, customerId, error },
      "Fieldpulse customer sync failed (degraded)",
    );
  }
}
