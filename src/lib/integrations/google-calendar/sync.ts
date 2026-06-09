/**
 * SYNC orchestration: keep a request's Google Calendar event in lockstep with
 * its schedule.
 *
 * Called from route `after()` background tasks — NEVER on the response path. The
 * golden rule here is DEGRADE SAFELY: every function no-ops (and logs at most a
 * warning) when the org isn't connected, the integration isn't configured, the
 * request has no arrival window, or Google returns an error. A calendar hiccup
 * must never fail or block a scheduling write.
 *
 * Tokens are never logged.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { getGoogleCalendarClient } from "./client";
import { getOrgGoogleTokens } from "./connection-queries";
import {
  serviceRequestToGoogleEvent,
  type RequestEventInput,
} from "./event-mapping";

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

/**
 * Load the fields the event mapper needs for one request, tenant-scoped. Returns
 * null when the request doesn't exist or has no arrival window (nothing to
 * sync). PII is decrypted here, in memory, only for the event body.
 */
async function loadRequestEventInput(
  organizationId: string,
  requestId: string,
): Promise<RequestEventInput | null> {
  const [row] = await db
    .select({
      id: serviceRequests.id,
      referenceNumber: serviceRequests.referenceNumber,
      issueType: serviceRequests.issueType,
      urgency: serviceRequests.urgency,
      description: serviceRequests.description,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
      customerNameEncrypted: serviceRequests.customerNameEncrypted,
      customerPhoneEncrypted: serviceRequests.customerPhoneEncrypted,
      addressEncrypted: serviceRequests.addressEncrypted,
      accessNotes: serviceRequests.accessNotes,
      assignedToName: users.name,
    })
    .from(serviceRequests)
    .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.id, requestId),
      ),
    );

  if (!row || !row.arrivalWindowStart || !row.arrivalWindowEnd) {
    return null;
  }

  return {
    id: row.id,
    referenceNumber: row.referenceNumber,
    issueType: row.issueType,
    urgency: row.urgency,
    description: row.description,
    arrivalWindowStart: row.arrivalWindowStart,
    arrivalWindowEnd: row.arrivalWindowEnd,
    customerName: safeDecrypt(row.customerNameEncrypted),
    customerPhone: safeDecrypt(row.customerPhoneEncrypted),
    addressText: safeDecrypt(row.addressEncrypted),
    accessNotes: row.accessNotes,
    assignedToName: row.assignedToName,
  };
}

/**
 * Upsert the Google Calendar event for a scheduled/rescheduled/assigned request.
 * No-ops when: the integration isn't configured, the org isn't connected, or the
 * request has no arrival window. Any Google error is logged + swallowed.
 *
 * `fetchImpl` is injectable for tests.
 */
export async function syncRequestToCalendar(
  organizationId: string,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const client = getGoogleCalendarClient(fetchImpl);
  if (!client) {
    return; // integration not configured — safe no-op
  }
  const tokens = await getOrgGoogleTokens(organizationId);
  if (!tokens) {
    return; // org not connected — safe no-op
  }

  try {
    const input = await loadRequestEventInput(organizationId, requestId);
    if (!input) {
      return; // no schedulable window yet — nothing to push
    }
    const event = serviceRequestToGoogleEvent(input);
    const result = await client.upsertEvent(tokens, event);
    logger.info(
      { organizationId, requestId, created: result.created },
      "Synced request to Google Calendar",
    );
  } catch (error: unknown) {
    // Degrade: a calendar failure must not surface to the dispatcher.
    logger.warn(
      { organizationId, requestId, error },
      "Google Calendar sync failed (degraded)",
    );
  }
}

/**
 * Delete the Google Calendar event for a cancelled request. Same degrade-safe
 * contract as {@link syncRequestToCalendar}.
 */
export async function deleteRequestFromCalendar(
  organizationId: string,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const client = getGoogleCalendarClient(fetchImpl);
  if (!client) {
    return;
  }
  const tokens = await getOrgGoogleTokens(organizationId);
  if (!tokens) {
    return;
  }

  try {
    await client.deleteEvent(tokens, requestId);
    logger.info(
      { organizationId, requestId },
      "Deleted request from Google Calendar",
    );
  } catch (error: unknown) {
    logger.warn(
      { organizationId, requestId, error },
      "Google Calendar delete failed (degraded)",
    );
  }
}
