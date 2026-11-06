/**
 * GDPR erasure + tenant purge primitives.
 *
 * Two destructive operations live here, both written for the neon-http driver
 * (NO interactive transactions — db.batch executes a non-interactive atomic
 * batch; db.transaction() throws at runtime):
 *
 *  - anonymizeCustomer: the right-to-erasure primitive. It does NOT delete the
 *    customer row (financial history must survive, de-identified). Instead it
 *    SCRUBS every PII column, NULLS the blind indexes (so the contact can never
 *    be re-resolved to this row and a new submit creates a fresh customer), and
 *    deletes the genuinely-personal child rows (chat messages, notes,
 *    attachments). Every statement is tenant + customer scoped.
 *
 *  - purgeOrganization: the platform tenant-purge. A single DELETE on the org
 *    cascades the whole tenant (see migration 0017 — 24 org FKs are ON DELETE
 *    CASCADE). Evidence is written to platform_audit_log FIRST, because that
 *    table is intentionally NOT org-FK'd and so survives the cascade.
 *
 * A third, read-only helper also lives here — listContactSiblings — the
 * erasure sibling DISCLOSURE required by customer-identity SPEC §5.1: since
 * one contact hash can now legitimately match several unrelated customers,
 * the erase confirmation surfaces them so an operator erases each row that is
 * genuinely the same person, one at a time. It never triggers an erase itself.
 *
 * R2 object cleanup is best-effort and runs in after() (never a detached
 * promise — Vercel freezes the function after the response otherwise).
 */
import "server-only";
import { after } from "next/server";
import { eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizations,
  customers,
  customerSessions,
  customerLocations,
  customerContacts,
  entityTags,
  customerNotes,
  messages,
  attachments,
  serviceRequests,
  appointments,
  serviceHistory,
  estimates,
  communicationJobs,
  communicationPreferences,
  customerEquipment,
  followUps,
  reviewRequests,
  requestNotes,
  customFieldValues,
  technicianTimeEntries,
  auditLog,
  platformAuditLog,
  invoices,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logAudit } from "@/lib/admin/audit";
import { invalidateCustomerSearchCache } from "@/lib/admin/crm-queries";
import { encrypt, decrypt } from "@/lib/crypto";
import { getStorageClient } from "@/lib/storage/r2-client";
import { storageKeyFromPublicUrl } from "@/lib/storage/storage-key";
import { logger } from "@/lib/logger";

/** Sentinel plaintext written into the two NOT NULL encrypted columns. */
const DELETED_PLACEHOLDER = "[deleted]";

function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

/**
 * Signature URLs → distinct R2 object keys. A null URL or one outside
 * R2_PUBLIC_URL (foreign prefix) yields no key; the request and its invoice
 * snapshot usually share one object, so keys are deduped.
 */
function signatureKeys(urls: readonly (string | null)[]): string[] {
  const keys = urls
    .map((url) => storageKeyFromPublicUrl(url))
    .filter((key): key is string => key !== null);
  return [...new Set(keys)];
}

/**
 * Best-effort deletion of R2 objects. Runs in after() so a slow/down R2 never
 * blocks the response, and so the work isn't a detached promise that Vercel
 * would freeze. Each key is independent — one failure never aborts the rest.
 */
function scheduleStorageCleanup(storageKeys: readonly string[]): void {
  if (storageKeys.length === 0) return;
  after(async () => {
    const client = getStorageClient();
    for (const key of storageKeys) {
      try {
        await client.deleteFile(key);
      } catch (error) {
        // Orphaned object is acceptable (the DB row is already gone); log id only.
        logger.error({ error, storageKey: key }, "R2 cleanup failed");
      }
    }
  });
}

/**
 * Anonymizes a single customer (GDPR right-to-erasure) within an org.
 *
 * Returns false when no such customer exists in the org. Otherwise scrubs all
 * PII (and nulls the blind indexes), deletes personal child rows, schedules R2
 * cleanup, audits with NO PII, and returns true.
 *
 * KEPT, de-identified: invoices/line items, payments, refunds, financing
 * applications, estimate options/line items, memberships + visits, request
 * status events, bot events, job materials, technician time entries. The
 * customerId link on service_requests is intentionally PRESERVED so financial
 * history stays attributable to the (now anonymous) record.
 */
export async function anonymizeCustomer(
  organizationId: string,
  customerId: string,
): Promise<boolean> {
  const [existing] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)));

  if (!existing) return false;

  // Pre-read: this customer's session ids (to scrub the sessions + delete their
  // messages) and their service requests (request_notes / time-entry notes /
  // custom field values keyed off those rows must be scrubbed —
  // service_requests rows are KEPT de-identified, so their child-row cascade
  // never fires). A session belongs to the customer when it is linked directly
  // (customer_sessions.customer_id) OR when one of their requests came from it
  // (service_requests.session_id) — many intake sessions never get the direct
  // link, yet their metadata/token carry the same name, phone and email.
  const [sessionRows, requestRows] = await Promise.all([
    db
      .select({ id: customerSessions.id })
      .from(customerSessions)
      .where(
        withTenant(
          customerSessions,
          organizationId,
          eq(customerSessions.customerId, customerId),
        ),
      ),
    db
      .select({
        id: serviceRequests.id,
        signatureUrl: serviceRequests.signatureUrl,
        sessionId: serviceRequests.sessionId,
      })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.customerId, customerId),
        ),
      ),
  ]);

  const sessionIds = [
    ...new Set([
      ...sessionRows.map((r) => r.id),
      ...requestRows.map((r) => r.sessionId),
    ]),
  ];
  const requestIds = requestRows.map((r) => r.id);

  // Attachments: the customer's own (admin uploads) AND every chat upload in
  // their sessions — those carry only session_id/message_id, and must go
  // before the messages they point at (attachments.message_id FK).
  const attachmentMatch = or(
    eq(attachments.customerId, customerId),
    inArray(attachments.sessionId, sessionIds),
  )!;
  const attachmentRows = await db
    .select({ storageKey: attachments.storageKey })
    .from(attachments)
    .where(withTenant(attachments, organizationId, attachmentMatch));

  // Invoice signature snapshots (M3b): the customer's own invoices OR any
  // invoice on the customer's requests (an estimate-born invoice may carry a
  // different customer id). Read BEFORE the scrub so the objects can be deleted.
  const invoiceSignatureMatch = or(
    eq(invoices.customerId, customerId),
    inArray(invoices.serviceRequestId, requestIds),
  )!;
  // Estimate signatures (M3c): the same rule. A field sale writes the typed name
  // onto the estimate of the REQUEST, whose customer id is pinned at create.
  const estimateSignatureMatch = or(
    eq(estimates.customerId, customerId),
    inArray(estimates.serviceRequestId, requestIds),
  )!;
  const invoiceSignatureRows = await db
    .select({ signatureUrl: invoices.signatureUrl })
    .from(invoices)
    .where(withTenant(invoices, organizationId, invoiceSignatureMatch));

  const attachmentKeys = attachmentRows.map((r) => r.storageKey);
  const storageKeys = [
    ...attachmentKeys,
    ...signatureKeys([
      ...requestRows.map((r) => r.signatureUrl),
      ...invoiceSignatureRows.map((r) => r.signatureUrl),
    ]),
  ];

  const now = new Date();

  // ONE non-interactive atomic batch. All statements are tenant + customer
  // scoped. Deletes target the genuinely-personal child rows; everything else
  // is an order-independent UPDATE that nulls/scrubs PII in place.
  await db.batch([
    // Attachments first: a chat upload's message_id references a message
    // deleted just below.
    db
      .delete(attachments)
      .where(withTenant(attachments, organizationId, attachmentMatch)),
    // Delete chat transcript for this customer's sessions (PII free-text).
    // inArray over an empty list is a valid no-op (matches nothing).
    db
      .delete(messages)
      .where(
        withTenant(
          messages,
          organizationId,
          inArray(messages.sessionId, sessionIds),
        ),
      ),
    db
      .delete(customerNotes)
      .where(
        withTenant(
          customerNotes,
          organizationId,
          eq(customerNotes.customerId, customerId),
        ),
      ),
    // Customer row: scrub PII, NULL the blind indexes (frees the per-org unique
    // index AND makes the contact un-re-resolvable), drop the portal token.
    // name_encrypted is NOT NULL -> write encrypt("[deleted]"), never null.
    db
      .update(customers)
      .set({
        nameEncrypted: encrypt(DELETED_PLACEHOLDER),
        emailEncrypted: null,
        phoneEncrypted: null,
        addressEncrypted: null,
        emailHash: null,
        phoneHash: null,
        portalTokenHash: null,
        portalTokenCreatedAt: null,
        notes: null,
        anonymizedAt: now,
      })
      .where(
        withTenant(customers, organizationId, eq(customers.id, customerId)),
      ),
    // Service locations: address_encrypted is NOT NULL -> placeholder; null the
    // blind index + the rest of the location PII.
    db
      .update(customerLocations)
      .set({
        addressEncrypted: encrypt(DELETED_PLACEHOLDER),
        addressHash: null,
        accessNotes: null,
        latitude: null,
        longitude: null,
        label: null,
      })
      .where(
        withTenant(
          customerLocations,
          organizationId,
          eq(customerLocations.customerId, customerId),
        ),
      ),
    // Service requests: scrub the denormalized contact snapshot + signature, but
    // KEEP the customerId link and the status/financial fields.
    db
      .update(serviceRequests)
      .set({
        customerNameEncrypted: null,
        customerPhoneEncrypted: null,
        customerEmailEncrypted: null,
        addressEncrypted: null,
        accessNotes: null,
        signatureName: null,
        signatureUrl: null,
      })
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.customerId, customerId),
        ),
      ),
    // Invoices: scrub ONLY the signature snapshot (signed_at and every money
    // column are kept). Same match as the pre-read above.
    db
      .update(invoices)
      .set({ signatureUrl: null, signatureName: null })
      .where(withTenant(invoices, organizationId, invoiceSignatureMatch)),
    // Visits #2+: special instructions are office free text that can carry PII.
    db
      .update(appointments)
      .set({ specialInstructions: null })
      .where(
        withTenant(
          appointments,
          organizationId,
          inArray(
            appointments.serviceRequestId,
            db
              .select({ id: serviceRequests.id })
              .from(serviceRequests)
              .where(
                withTenant(
                  serviceRequests,
                  organizationId,
                  eq(serviceRequests.customerId, customerId),
                ),
              ),
          ),
        ),
      ),
    // Estimates: drop the e-signature name + IP and who sold it, on the
    // customer's own estimates OR any estimate on the customer's requests.
    db
      .update(estimates)
      .set({ signatureName: null, signatureIp: null, soldBy: null })
      .where(withTenant(estimates, organizationId, estimateSignatureMatch)),
    // Detach + scrub the chat sessions (the messages are already deleted
    // above). metadata holds the plaintext intake slots (name, phone, email,
    // address, free-text extras); every reader treats NULL as "nothing
    // captured", the state a brand-new session starts in. An SMS thread's token
    // is "sms:<phone>" (or "sms:<phone>:<id>" once retired): rewrite it to a
    // unique non-PII value, which also stops a later text from that number
    // reattaching to this transcript. Other tokens (web random, CallSid,
    // admin-/mvisit-/fp-import- markers) carry no PII and are left alone —
    // the FieldPulse import dedupes on its marker.
    db
      .update(customerSessions)
      .set({
        customerId: null,
        summary: null,
        runningSummary: null,
        nextSteps: null,
        metadata: null,
        token: sql`CASE WHEN ${customerSessions.token} LIKE 'sms:%' THEN 'erased:' || ${customerSessions.id}::text ELSE ${customerSessions.token} END`,
      })
      .where(
        withTenant(
          customerSessions,
          organizationId,
          inArray(customerSessions.id, sessionIds),
        ),
      ),
    // Outbound comms: scrub recipient PII + template variables (which carry
    // name/address for rendering).
    db
      .update(communicationJobs)
      .set({
        recipientPhoneEncrypted: null,
        recipientEmailEncrypted: null,
        templateVariables: {},
        // Provider error strings can embed the recipient phone/email (e.g. a
        // Twilio "invalid number +1555…" message). Clear them too.
        errorMessage: null,
      })
      .where(
        withTenant(
          communicationJobs,
          organizationId,
          eq(communicationJobs.customerId, customerId),
        ),
      ),
    // Service history: technician_notes is free text that can carry PII.
    db
      .update(serviceHistory)
      .set({ technicianNotes: null })
      .where(
        withTenant(
          serviceHistory,
          organizationId,
          eq(serviceHistory.customerId, customerId),
        ),
      ),
    // Review requests: feedback is PRIVATE free text.
    db
      .update(reviewRequests)
      .set({ feedback: null })
      .where(
        withTenant(
          reviewRequests,
          organizationId,
          eq(reviewRequests.customerId, customerId),
        ),
      ),
    // Follow-ups: `reason` is free text that can carry PII; delete outright (a
    // scheduled follow-up has no value once the customer is erased).
    db
      .delete(followUps)
      .where(
        withTenant(
          followUps,
          organizationId,
          eq(followUps.customerId, customerId),
        ),
      ),
    // Customer equipment: KEEP the de-identified asset row, but null the
    // free-text install notes (can carry PII).
    db
      .update(customerEquipment)
      .set({ notes: null })
      .where(
        withTenant(
          customerEquipment,
          organizationId,
          eq(customerEquipment.customerId, customerId),
        ),
      ),
    // Communication preferences: the per-customer do-not-contact/preference link
    // (customerId is a bare UUID, no FK) — delete it with the customer.
    db
      .delete(communicationPreferences)
      .where(
        withTenant(
          communicationPreferences,
          organizationId,
          eq(communicationPreferences.customerId, customerId),
        ),
      ),
    // Custom field VALUES attached to this customer (and to their kept service
    // requests) are free-form PII (gate codes, preferred-contact text, etc.).
    // entityId uniquely identifies the row regardless of entityType, so match by
    // the customer's id + their request ids. [customerId, ...requestIds] is never
    // empty, so inArray always has a target.
    db
      .delete(customFieldValues)
      .where(
        withTenant(
          customFieldValues,
          organizationId,
          inArray(customFieldValues.entityId, [customerId, ...requestIds]),
        ),
      ),
    // Internal dispatcher notes (free text → PII) on this customer's requests.
    // The requests are KEPT de-identified, so the FK cascade never fires; delete
    // the notes explicitly. inArray([]) is a valid no-op when there are none.
    db
      .delete(requestNotes)
      .where(
        withTenant(
          requestNotes,
          organizationId,
          inArray(requestNotes.requestId, requestIds),
        ),
      ),
    // Technician time-entry notes on this customer's requests can carry PII.
    db
      .update(technicianTimeEntries)
      .set({ note: null })
      .where(
        withTenant(
          technicianTimeEntries,
          organizationId,
          inArray(technicianTimeEntries.serviceRequestId, requestIds),
        ),
      ),
    // Contacts carry their own encrypted PII: delete outright. Tags are not PII
    // but must not dangle on the erased customer or its locations.
    db.delete(customerContacts).where(withTenant(customerContacts, organizationId, eq(customerContacts.customerId, customerId))),
    db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "customer"), eq(entityTags.entityId, customerId))),
    db.delete(entityTags).where(withTenant(entityTags, organizationId, eq(entityTags.entity, "location"),
      inArray(entityTags.entityId, db.select({ id: customerLocations.id }).from(customerLocations).where(withTenant(customerLocations, organizationId, eq(customerLocations.customerId, customerId)))))),
    // Audit: counts/table names ONLY — never name/email/phone.
    db.insert(auditLog).values({
      organizationId,
      userId: null,
      action: "customer_erased",
      entity: "customers",
      entityId: customerId,
      details: JSON.stringify({
        sessions: sessionIds.length,
        attachmentsDeleted: attachmentKeys.length,
      }),
    }),
  ]);

  invalidateCustomerSearchCache(organizationId);
  scheduleStorageCleanup(storageKeys);

  return true;
}

/** A row in the org that shares the erasure target's email or phone hash. */
export interface ContactSibling {
  readonly id: string;
  readonly name: string | null;
}

/**
 * Lists the OTHER customer rows in the org that share the target customer's
 * email hash or phone hash — id plus server-side decrypted name only (the
 * hashes themselves never leave this function).
 *
 * Per SPEC §5.1: post-split, a hash match usually means a DIFFERENT data
 * subject (e.g. several FieldPulse-linked businesses sharing one
 * accounts-payable contact), not the same person split across rows. So this
 * is disclosure only, feeding the erase confirmation UI so an operator can
 * see "this contact appears on N rows" and deliberately erase each row that
 * is genuinely the same person, one at a time — NEVER auto-fan-out.
 *
 * Excludes the target row itself and any already-anonymized row (nothing
 * left to disclose there). Returns [] when the target does not exist in the
 * org, or carries neither hash (already erased, or no matched contact yet).
 */
export async function listContactSiblings(
  organizationId: string,
  customerId: string,
): Promise<readonly ContactSibling[]> {
  const [target] = await db
    .select({ emailHash: customers.emailHash, phoneHash: customers.phoneHash })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, customerId)));

  if (!target || (!target.emailHash && !target.phoneHash)) return [];

  // EITHER hash, not both — a sibling can share just the email or just the
  // phone (e.g. same AP email, different phone per business).
  const contactMatch = or(
    target.emailHash ? eq(customers.emailHash, target.emailHash) : undefined,
    target.phoneHash ? eq(customers.phoneHash, target.phoneHash) : undefined,
  )!;

  const rows = await db
    .select({ id: customers.id, nameEncrypted: customers.nameEncrypted })
    .from(customers)
    .where(
      withTenant(
        customers,
        organizationId,
        contactMatch,
        ne(customers.id, customerId),
        isNull(customers.anonymizedAt),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    name: safeDecrypt(row.nameEncrypted),
  }));
}

/** The platform operator performing a purge/export (recorded in the evidence). */
export interface PlatformActor {
  readonly userId: string;
  readonly email: string;
}

/**
 * Purges an entire tenant (platform-only). Writes a platform_audit_log row
 * FIRST (it survives the cascade because it is not org-FK'd), then DELETEs the
 * organization in a single statement — migration 0017 makes every org FK
 * ON DELETE CASCADE, so the whole tenant is removed by the database.
 *
 * Returns false when the org does not exist. R2 objects for the org are cleaned
 * up best-effort in after().
 */
export async function purgeOrganization(
  targetOrgId: string,
  actor: PlatformActor,
): Promise<boolean> {
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, targetOrgId));

  if (!org) return false;

  // Pre-read the org's R2 keys (attachment storage keys + the signature URLs
  // on requests AND invoices, mapped to object keys) BEFORE the cascade
  // removes the rows.
  const [attachmentRows, requestSignatureRows, invoiceSignatureRows] =
    await Promise.all([
      db
        .select({ storageKey: attachments.storageKey })
        .from(attachments)
        .where(eq(attachments.organizationId, targetOrgId)),
      db
        .select({ signatureUrl: serviceRequests.signatureUrl })
        .from(serviceRequests)
        .where(eq(serviceRequests.organizationId, targetOrgId)),
      db
        .select({ signatureUrl: invoices.signatureUrl })
        .from(invoices)
        .where(eq(invoices.organizationId, targetOrgId)),
    ]);

  const signatureObjectKeys = signatureKeys([
    ...requestSignatureRows.map((r) => r.signatureUrl),
    ...invoiceSignatureRows.map((r) => r.signatureUrl),
  ]);
  const storageKeys = [
    ...attachmentRows.map((r) => r.storageKey),
    ...signatureObjectKeys,
  ];

  // Evidence FIRST — this row outlives the org (no FK to organizations).
  await db.insert(platformAuditLog).values({
    action: "org_purged",
    actorUserId: actor.userId,
    actorEmail: actor.email,
    targetOrgId,
    details: {
      attachments: attachmentRows.length,
      signatures: signatureObjectKeys.length,
    },
  });

  // Single statement; the database cascades the rest.
  await db.delete(organizations).where(eq(organizations.id, targetOrgId));

  scheduleStorageCleanup(storageKeys);

  return true;
}

// Re-export logAudit so the customer-erase route can audit the human actor
// (anonymizeCustomer's own audit row records the system action; the route adds
// the actor + ip context, mirroring how deleteCustomer is audited at the route).
export { logAudit };
