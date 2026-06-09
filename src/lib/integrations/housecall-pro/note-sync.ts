/**
 * NOTE SYNC: push a dispatcher's note (or appointment update) onto the request's
 * Housecall Pro job so the FIELD TECH sees it. (Stage 5 of the HCP integration.)
 *
 * Called from route `after()` background tasks — NEVER on the response path. The
 * golden rule, mirroring job-sync.ts and the Google Calendar sync, is DEGRADE
 * SAFELY: every path no-ops (logging at most a warning) when the org isn't
 * HCP-connected, the request doesn't exist, the request has no mapped HCP job
 * (it isn't in HCP yet), the note is empty, or HCP returns an error. A sync
 * hiccup must never fail or block the admin response.
 *
 * Notes are APPENDED, so idempotency isn't critical — a repeat just adds another
 * note. We do guard against empty notes (nothing useful to push). The note text
 * is staff free-text; like the audit trail, it is NOT logged (only the request
 * id / job id are). The API key is never logged.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logger } from "@/lib/logger";
import { getHousecallClient } from "./client";

/**
 * Append a dispatcher note to the request's HCP job. Best-effort:
 *
 *  - No-ops when the note is empty/whitespace (nothing to push).
 *  - No-ops when the org isn't HCP-connected (no client).
 *  - No-ops when the request doesn't exist in the org.
 *  - No-ops when the request has no mapped HCP job (not pushed to HCP yet — a
 *    later job push will create it; the note isn't retro-applied here).
 *
 * Any HCP/network error is logged at WARN and swallowed — never thrown.
 * `fetchImpl` is injectable so tests mock the network and never hit the real API.
 */
export async function syncJobNoteToHcp(
  organizationId: string,
  serviceRequestId: string,
  note: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // Guard against empty notes up front — no client/DB work for nothing to push.
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    return; // nothing useful to push
  }

  const client = await getHousecallClient(organizationId, fetchImpl);
  if (!client) {
    return; // org not HCP-connected (no key) — safe no-op
  }

  try {
    const [row] = await db
      .select({ hcpJobId: serviceRequests.hcpJobId })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.id, serviceRequestId),
        ),
      );

    if (!row?.hcpJobId) {
      // Unknown request, or the request isn't in HCP yet — nothing to attach the
      // note to. Degrade quietly: the note still lives in our DB.
      return;
    }

    await client.addJobNote(row.hcpJobId, trimmed);
    logger.info(
      { organizationId, serviceRequestId, hcpJobId: row.hcpJobId },
      "Pushed note to Housecall Pro job",
    );
  } catch (error: unknown) {
    // Degrade: an HCP failure must not surface to the admin note flow.
    logger.warn(
      { organizationId, serviceRequestId, error },
      "Housecall Pro note push failed (degraded)",
    );
  }
}
