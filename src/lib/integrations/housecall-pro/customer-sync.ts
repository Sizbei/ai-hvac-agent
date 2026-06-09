/**
 * CUSTOMER SYNC: mirror one of our CRM customers into Housecall Pro and remember
 * the mapping (customers.hcp_customer_id).
 *
 * Called from route `after()` background tasks — NEVER on the response path. The
 * golden rule, mirroring the Google Calendar sync, is DEGRADE SAFELY: every path
 * no-ops (logging at most a warning) when the org isn't HCP-connected, the
 * customer doesn't exist, or HCP returns an error. A sync hiccup must never fail
 * or block a booking.
 *
 * IDEMPOTENT: once customers.hcp_customer_id is set, a re-sync no-ops. Before
 * creating, we ask HCP's own lookup (find-by email/phone) so we don't create a
 * duplicate HCP customer for one that already exists there — pairing with our
 * blind-index dedupe (which already guarantees ONE row per contact on our side).
 *
 * The API key is never logged; PII is decrypted only in memory for the HCP body.
 */
import { eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { getHousecallClient } from "./client";
import type {
  HousecallAddress,
  HousecallCustomer,
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

/** Placeholder HCP last name when our single `name` field has no surname. */
const HCP_UNKNOWN_LAST_NAME = "Customer";

/**
 * Split our single `name` field into HCP's first/last. HCP requires a last name;
 * a single-token name (or empty) is sent as first + a placeholder last so the
 * create never fails on a missing surname.
 */
export function splitName(fullName: string | null): {
  readonly firstName: string;
  readonly lastName: string;
} {
  const trimmed = (fullName ?? "").trim();
  if (trimmed.length === 0) {
    return { firstName: "Unknown", lastName: HCP_UNKNOWN_LAST_NAME };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0]!, lastName: HCP_UNKNOWN_LAST_NAME };
  }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts[parts.length - 1]!,
  };
}

/** Our decrypted customer fields, used to build the HCP create payload. */
interface CustomerContact {
  readonly name: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly address: string | null;
}

/**
 * Build the HCP create-customer payload from our decrypted contact. We carry the
 * free-text address into HCP's `street` field — HCP accepts a loosely-structured
 * address and we don't parse it into components.
 */
function toCreateInput(contact: CustomerContact): CreateCustomerInput {
  const { firstName, lastName } = splitName(contact.name);
  const address: HousecallAddress | undefined = contact.address
    ? { street: contact.address }
    : undefined;
  return {
    firstName,
    lastName,
    email: contact.email ?? undefined,
    mobileNumber: contact.phone ?? undefined,
    address,
  };
}

/** Build HCP's find query from our contact (email preferred, phone fallback). */
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
 * HCP's customer search (`q=`) is a broad/fuzzy free-text match, so the top hit
 * is NOT guaranteed to be the same contact. Before reusing it as our mapping we
 * VERIFY the candidate's email or phone actually equals what we searched on; a
 * non-exact hit is rejected so we fall through to create rather than mapping our
 * customer to the wrong HCP record.
 */
function isExactMatch(
  contact: CustomerContact,
  candidate: HousecallCustomer,
): boolean {
  if (emailsMatch(contact.email, candidate.email)) {
    return true;
  }
  return (
    phonesMatch(contact.phone, candidate.mobile_number) ||
    phonesMatch(contact.phone, candidate.home_number)
  );
}

/**
 * Mirror our customer into Housecall Pro and persist the resulting HCP id on our
 * row. Best-effort + idempotent:
 *
 *  - No-ops when the org isn't HCP-connected (no client) or the customer doesn't
 *    exist in the org.
 *  - No-ops when customers.hcp_customer_id is already set (already mapped).
 *  - Otherwise: ask HCP to find an existing customer by email/phone first
 *    (avoids duplicate HCP records); only create when none is found.
 *  - Stores the HCP id with a guard (... AND hcp_customer_id IS NULL) so two
 *    concurrent syncs can't clobber each other.
 *
 * Any HCP/network error is logged at WARN and swallowed — never thrown.
 * `fetchImpl` is injectable so tests mock the network and never hit the real API.
 */
export async function syncCustomerToHcp(
  organizationId: string,
  customerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const client = await getHousecallClient(organizationId, fetchImpl);
  if (!client) {
    return; // org not HCP-connected (no key) — safe no-op
  }

  try {
    const [row] = await db
      .select({
        id: customers.id,
        hcpCustomerId: customers.hcpCustomerId,
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
    if (row.hcpCustomerId) {
      return; // already mapped — idempotent no-op
    }

    const contact: CustomerContact = {
      name: safeDecrypt(row.nameEncrypted),
      email: safeDecrypt(row.emailEncrypted),
      phone: safeDecrypt(row.phoneEncrypted),
      address: safeDecrypt(row.addressEncrypted),
    };

    // Find-or-create against HCP. Prefer an existing HCP customer (by email,
    // else phone) to avoid duplicates; create only when none matches. HCP's
    // search is fuzzy, so we only reuse a candidate that EXACTLY matches our
    // email/phone — otherwise we create rather than risk a wrong mapping.
    const findQuery = toFindQuery(contact);
    const candidate = findQuery ? await client.findCustomer(findQuery) : null;
    const existing =
      candidate && isExactMatch(contact, candidate) ? candidate : null;
    const hcpId = existing
      ? existing.id
      : (await client.createCustomer(toCreateInput(contact))).id;

    // Persist the mapping, guarded on hcp_customer_id IS NULL so a racing sync
    // that already wrote an id is never overwritten.
    await db
      .update(customers)
      .set({ hcpCustomerId: hcpId, updatedAt: new Date() })
      .where(
        withTenant(
          customers,
          organizationId,
          eq(customers.id, customerId),
          isNull(customers.hcpCustomerId),
        ),
      );

    logger.info(
      { organizationId, customerId, created: existing === null },
      "Synced customer to Housecall Pro",
    );
  } catch (error: unknown) {
    // Degrade: an HCP failure must not surface to the booking flow.
    logger.warn(
      { organizationId, customerId, error },
      "Housecall Pro customer sync failed (degraded)",
    );
  }
}
