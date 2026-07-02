import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { findCustomerIdByContact } from "@/lib/admin/crm-queries";
import { getCustomerServiceHistory } from "@/lib/integrations/housecall-pro/customer-history";

/**
 * Light, NON-PII-leaking context about a customer the chat agent has just
 * identified mid-conversation, used to personalize the reply (greet a returning
 * customer, skip re-asking known info) and to enforce the "Do Not Service" flag
 * early — before the confirm step where it would otherwise first surface.
 *
 * Deliberately minimal: counts + enums + flags, plus the customer's FIRST name
 * only (so the bot can greet them by name). The full name / phone / email / the
 * address are NOT returned — the prompt only ever needs the first name and the
 * non-identifying facts below.
 */
export interface CustomerContext {
  readonly customerId: string;
  /** Always true here — the object only exists when a prior customer matched. */
  readonly isReturning: boolean;
  /** Number of service requests already on file for this customer. */
  readonly priorRequestCount: number;
  readonly membershipStatus: string;
  readonly customerType: string;
  /** ServiceTitan "Do Not Service" — the bot must refuse to book + route to a human. */
  readonly doNotService: boolean;
  /** First token of the customer's stored name, if any (for a by-name greeting). */
  readonly firstName: string | null;
  /**
   * The customer's full stored name, if any. PII — used ONLY server-side to
   * pre-fill the name slot so intake doesn't re-ask a returning customer. It is
   * NEVER placed in the system-prompt hint (see {@link buildCustomerContextHint},
   * which surfaces only the first name + non-identifying facts).
   */
  readonly fullName: string | null;
  /**
   * The customer's Housecall Pro id, if we've mirrored them there. Used ONLY
   * server-side as the seam into HCP service history (see
   * {@link enrichWithServiceHistory}); never placed in the prompt hint.
   */
  readonly hcpCustomerId: string | null;
  /**
   * Optional one-line, PII-free prior-service note derived from HCP job history
   * (e.g. "Most recent service: March 2026 — replaced capacitor."). Absent until
   * a best-effort {@link enrichWithServiceHistory} pass fills it; surfaced in the
   * hint when present. Best-effort: stays null when HCP is absent or errors.
   */
  readonly priorServiceNote?: string | null;
}

/**
 * Extracts a first name from a decrypted full name. Returns null for the
 * "Unknown" placeholder (written by upsert when no name was provided) and for
 * empty/whitespace values, so the bot never greets someone as "Unknown".
 */
function firstNameFrom(fullName: string | null): string | null {
  if (!fullName) return null;
  const trimmed = fullName.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === "unknown") return null;
  const first = trimmed.split(/\s+/)[0];
  return first && first.length > 0 ? first : null;
}

/** Decrypt the stored name, swallowing any decrypt error (returns null). */
function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

/**
 * Looks up an existing customer for the org by email and/or phone WITHOUT
 * creating one, returning light personalization context or null when no
 * customer matches.
 *
 * Pure read. Uses the existing blind-index dedupe (`findCustomerIdByContact`)
 * to resolve the id, then a single targeted select for the context fields +
 * a correlated count of prior service requests. Never inserts or updates —
 * customer creation happens only at confirm time (`upsertCustomerByContact`),
 * so an in-progress chat never materializes a customer before the customer
 * actually confirms.
 *
 * Returns null when neither a normalized email nor phone is supplied, or when
 * nothing matches.
 */
export async function lookupCustomerContext(
  organizationId: string,
  contact: { readonly email?: string | null; readonly phone?: string | null },
): Promise<CustomerContext | null> {
  const customerId = await findCustomerIdByContact(organizationId, {
    email: contact.email ?? null,
    phone: contact.phone ?? null,
  });

  if (!customerId) return null;

  return loadCustomerContextById(organizationId, customerId);
}

/**
 * Load a returning-customer context for an ALREADY-KNOWN customer id — the
 * resolved half of {@link lookupCustomerContext}, without the contact lookup.
 * Used by the voice path, where the call's session already carries `customerId`
 * (resolved from ANI at call start), so re-deriving it from a contact is
 * unnecessary. Returns null when the row is gone (a raced delete).
 */
export async function loadCustomerContextById(
  organizationId: string,
  customerId: string,
): Promise<CustomerContext | null> {
  // Single light query: the customer's class/membership/flag + their name
  // (to derive a first name) + a correlated count of prior requests. No
  // over-fetch — equipment/notes/history are not needed for personalization.
  const [row] = await db
    .select({
      nameEncrypted: customers.nameEncrypted,
      customerType: customers.customerType,
      membershipStatus: customers.membershipStatus,
      doNotService: customers.doNotService,
      hcpCustomerId: customers.hcpCustomerId,
      priorRequestCount: sql<number>`(
        SELECT count(*)::int FROM service_requests
        WHERE service_requests.customer_id = ${customers.id}
      )`,
    })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)))
    .limit(1);

  // The id was known, but a concurrent delete could race; treat a missing row
  // as "no context" rather than throwing.
  if (!row) return null;

  const decryptedName = safeDecrypt(row.nameEncrypted);
  // Drop the "Unknown" placeholder so we don't pre-fill a junk name slot.
  const fullName =
    decryptedName && decryptedName.trim().toLowerCase() !== "unknown"
      ? decryptedName.trim()
      : null;

  return {
    customerId,
    isReturning: true,
    priorRequestCount: row.priorRequestCount ?? 0,
    membershipStatus: row.membershipStatus,
    customerType: row.customerType,
    doNotService: row.doNotService,
    firstName: firstNameFrom(decryptedName),
    fullName,
    hcpCustomerId: row.hcpCustomerId,
  };
}

/** Format an ISO date as "Month YYYY" (e.g. "March 2026"), or null if unparsable. */
function monthYear(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return new Date(ms).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * BEST-EFFORT enrichment: when the resolved customer is mapped into Housecall Pro
 * (has an hcpCustomerId) AND the org is HCP-connected, pull their past-job history
 * and attach a one-line, PII-free prior-service note to the context. Returns a NEW
 * context (immutable) — the caller swaps it in before building the hint.
 *
 * DEGRADE-SAFE and non-blocking by design:
 *  - null context → returned unchanged.
 *  - no hcpCustomerId (never mirrored) → returned unchanged, no HCP call.
 *  - HCP not connected / errors → {@link getCustomerServiceHistory} yields the
 *    empty summary, so the context is returned unchanged (no note added).
 *  - no past jobs → no note added.
 *
 * The existing context behavior is therefore identical when HCP is absent. Keep
 * this off the critical reply path or `await` it only where a small extra round
 * trip is acceptable; it never throws.
 */
export async function enrichWithServiceHistory(
  organizationId: string,
  context: CustomerContext | null,
  fetchImpl: typeof fetch = fetch,
): Promise<CustomerContext | null> {
  if (!context || !context.hcpCustomerId) {
    return context;
  }

  const history = await getCustomerServiceHistory(
    organizationId,
    context.hcpCustomerId,
    fetchImpl,
  );
  if (history.jobCount === 0) {
    return context; // no past jobs (or degraded) — leave context untouched
  }

  const when = monthYear(history.lastServiceDate);
  const what = history.lastServiceDescription?.trim();
  // Build the note from whatever we have; bail (no change) if neither is usable.
  let note: string | null = null;
  if (when && what) {
    note = `Most recent service: ${when} — ${what}.`;
  } else if (when) {
    note = `Most recent service: ${when}.`;
  } else if (what) {
    note = `Most recent service: ${what}.`;
  }
  if (!note) {
    return context;
  }

  return { ...context, priorServiceNote: note };
}

/**
 * Builds the brief, non-PII returning-customer note appended to the system
 * prompt on the LLM path. Greets by first name when known, acknowledges prior
 * service, and tells the model to skip re-asking info already on file. Returns
 * "" when there's no context so callers can concatenate unconditionally.
 */
export function buildCustomerContextHint(
  context: CustomerContext | null,
): string {
  if (!context) return "";

  const parts: string[] = [];
  if (context.firstName) {
    parts.push(`The returning customer's first name is ${context.firstName}.`);
  }
  if (context.priorRequestCount > 0) {
    const plural = context.priorRequestCount === 1 ? "request" : "requests";
    parts.push(
      `They have ${context.priorRequestCount} prior service ${plural} on file.`,
    );
  }
  if (context.membershipStatus === "active") {
    parts.push("They are an active member — acknowledge their membership warmly.");
  }
  if (context.customerType === "commercial") {
    parts.push("This is a commercial account.");
  }
  // Best-effort prior-service note from HCP history (PII-free: date + work only).
  if (context.priorServiceNote) {
    parts.push(context.priorServiceNote);
  }

  const facts = parts.join(" ");
  return (
    "\n\n[RETURNING CUSTOMER] " +
    (facts ? facts + " " : "") +
    "Greet them by name if known, acknowledge they're a returning customer, " +
    "and do NOT re-ask for their name or any contact info already on file."
  );
}
