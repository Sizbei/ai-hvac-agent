/**
 * NOTE SYNC: push dispatcher notes to Fieldpulse jobs.
 *
 * Mirrors housecall-pro/note-sync.ts: called from the admin PATCH route when a
 * dispatcher adds a note to a service request. The note is pushed to the mapped
 * Fieldpulse job as a job note.
 *
 * DEGRADE-SAFE: any Fieldpulse error is logged and swallowed — never blocks
 * the note from being persisted to our database.
 *
 * NOTE: Fieldpulse API shape for job notes is assumed based on common patterns.
 * Verify with Fieldpulse API docs before using in production.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logger } from "@/lib/logger";
import { getFieldpulseClient } from "./client";

// Fieldpulse may have a lower limit than our 5000 char max.
// Adjust based on actual API documentation.
const FIELDPULSE_MAX_NOTE_LENGTH = 5000;

/**
 * Truncate note to Fieldpulse's limit, appending ellipsis if cut.
 */
function truncateNote(note: string): string {
  if (note.length <= FIELDPULSE_MAX_NOTE_LENGTH) {
    return note;
  }
  return note.slice(0, FIELDPULSE_MAX_NOTE_LENGTH - 3) + "...";
}

/**
 * Normalize line endings and strip control characters (except tab/newline).
 * Fieldpulse may have specific requirements; adjust based on testing.
 */
function sanitizeNote(note: string): string {
  // Normalize line endings to LF
  let sanitized = note.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Remove control characters except tab, LF, CR
  sanitized = sanitized.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return sanitized;
}

/**
 * Push a dispatcher note to the mapped Fieldpulse job. No-ops when:
 *
 *  - Org isn't Fieldpulse-connected (no client)
 *  - Request doesn't exist
 *  - Request has no mapped Fieldpulse job
 *
 * Best-effort: any Fieldpulse error is logged at WARN and swallowed.
 *
 * `fetchImpl` is injectable so tests mock the network.
 */
export async function syncNoteToFieldpulse(
  organizationId: string,
  serviceRequestId: string,
  noteContent: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const client = await getFieldpulseClient(organizationId, fetchImpl);
  if (!client) {
    return; // org not connected — safe no-op
  }

  try {
    // Load the request's Fieldpulse job ID
    const [row] = await db
      .select({ fieldpulseJobId: serviceRequests.fieldpulseJobId })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.id, serviceRequestId),
        ),
      );

    if (!row?.fieldpulseJobId) {
      return; // no mapped Fieldpulse job — nothing to sync
    }

    // Prepare note for Fieldpulse (sanitize + truncate)
    const sanitized = sanitizeNote(noteContent);
    const truncated = truncateNote(sanitized);

    // Push to Fieldpulse
    await client.addJobNote(row.fieldpulseJobId, truncated);

    logger.info(
      { organizationId, serviceRequestId, fieldpulseJobId: row.fieldpulseJobId },
      "Synced note to Fieldpulse",
    );
  } catch (error: unknown) {
    // Degrade: a Fieldpulse failure must not surface to the dispatcher
    logger.warn(
      { organizationId, serviceRequestId, error },
      "Fieldpulse note sync failed (degraded)",
    );
  }
}
