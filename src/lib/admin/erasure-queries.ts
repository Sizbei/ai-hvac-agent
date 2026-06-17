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
 * R2 object cleanup is best-effort and runs in after() (never a detached
 * promise — Vercel freezes the function after the response otherwise).
 */
import "server-only";
import { after } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  organizations,
  customers,
  customerSessions,
  customerLocations,
  customerNotes,
  messages,
  attachments,
  serviceRequests,
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
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logAudit } from "@/lib/admin/audit";
import { encrypt } from "@/lib/crypto";
import { getStorageClient } from "@/lib/storage/r2-client";
import { logger } from "@/lib/logger";

/** Sentinel plaintext written into the two NOT NULL encrypted columns. */
const DELETED_PLACEHOLDER = "[deleted]";

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
  // messages), the R2 keys of their attachments (for after() cleanup), and the
  // ids of their service requests (request_notes / time-entry notes / custom
  // field values keyed off those rows must be scrubbed — service_requests rows
  // are KEPT de-identified, so their child-row cascade never fires).
  const [sessionRows, attachmentRows, requestRows] = await Promise.all([
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
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(
        withTenant(
          attachments,
          organizationId,
          eq(attachments.customerId, customerId),
        ),
      ),
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
  ]);

  const sessionIds = sessionRows.map((r) => r.id);
  const storageKeys = attachmentRows.map((r) => r.storageKey);
  const requestIds = requestRows.map((r) => r.id);

  const now = new Date();

  // ONE non-interactive atomic batch. All statements are tenant + customer
  // scoped. Deletes target the genuinely-personal child rows; everything else
  // is an order-independent UPDATE that nulls/scrubs PII in place.
  await db.batch([
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
    db
      .delete(attachments)
      .where(
        withTenant(
          attachments,
          organizationId,
          eq(attachments.customerId, customerId),
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
    // Estimates: drop the customer's e-signature name + IP.
    db
      .update(estimates)
      .set({ signatureName: null, signatureIp: null })
      .where(
        withTenant(
          estimates,
          organizationId,
          eq(estimates.customerId, customerId),
        ),
      ),
    // Detach + scrub the chat sessions (the messages are already deleted above).
    db
      .update(customerSessions)
      .set({ customerId: null, summary: null, runningSummary: null })
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
    // Audit: counts/table names ONLY — never name/email/phone.
    db.insert(auditLog).values({
      organizationId,
      userId: null,
      action: "customer_erased",
      entity: "customers",
      entityId: customerId,
      details: JSON.stringify({
        sessions: sessionIds.length,
        attachmentsDeleted: storageKeys.length,
      }),
    }),
  ]);

  scheduleStorageCleanup(storageKeys);

  return true;
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

  // Pre-read the org's R2 keys (attachment storage keys + service-request
  // signature URLs) BEFORE the cascade removes the rows.
  const [attachmentRows, signatureRows] = await Promise.all([
    db
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(eq(attachments.organizationId, targetOrgId)),
    db
      .select({ signatureUrl: serviceRequests.signatureUrl })
      .from(serviceRequests)
      .where(eq(serviceRequests.organizationId, targetOrgId)),
  ]);

  const storageKeys = [
    ...attachmentRows.map((r) => r.storageKey),
    ...signatureRows
      .map((r) => r.signatureUrl)
      .filter((u): u is string => typeof u === "string" && u.length > 0),
  ];

  // Evidence FIRST — this row outlives the org (no FK to organizations).
  await db.insert(platformAuditLog).values({
    action: "org_purged",
    actorUserId: actor.userId,
    actorEmail: actor.email,
    targetOrgId,
    details: {
      attachments: attachmentRows.length,
      signatures: signatureRows.length,
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
