/**
 * JOB SYNC: push a confirmed service request into Housecall Pro as a job, and
 * keep that HCP job in lockstep as our schedule changes or the request is
 * cancelled. (Stage 3 of the HCP integration.)
 *
 * Called from route `after()` background tasks — NEVER on the response path. The
 * golden rule, mirroring customer-sync.ts and the Google Calendar sync, is
 * DEGRADE SAFELY: every path no-ops (logging at most a warning) when the org
 * isn't HCP-connected, the request doesn't exist, or HCP returns an error. A
 * sync hiccup must never fail or block a booking or a reschedule.
 *
 * IDEMPOTENT: the HCP job id is stored on service_requests.hcp_job_id. Once set,
 * a re-push UPDATEs the existing HCP job (reschedule/re-describe) rather than
 * creating a duplicate. The push first ensures the customer is mirrored to HCP
 * (Stage 2 — syncCustomerToHcp) so the job can be keyed to an HCP customer id.
 *
 * The API key is never logged; PII is decrypted only in memory for the HCP body.
 */
import { eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { getHousecallClient } from "./client";
import { syncCustomerToHcp } from "./customer-sync";
import {
  serviceRequestToJobFields,
  type RequestJobInput,
} from "./job-mapping";

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

/** The request + customer fields the push needs, loaded tenant-scoped. */
interface JobSyncRow {
  readonly requestId: string;
  readonly hcpJobId: string | null;
  readonly customerId: string | null;
  readonly hcpCustomerId: string | null;
  readonly jobFields: RequestJobInput;
}

/**
 * Load one request joined to its CRM customer (for the HCP customer id), tenant-
 * scoped. Returns null when the request doesn't exist. PII is decrypted here, in
 * memory, only for the HCP job body.
 */
async function loadJobSyncRow(
  organizationId: string,
  requestId: string,
): Promise<JobSyncRow | null> {
  const [row] = await db
    .select({
      requestId: serviceRequests.id,
      hcpJobId: serviceRequests.hcpJobId,
      customerId: serviceRequests.customerId,
      hcpCustomerId: customers.hcpCustomerId,
      referenceNumber: serviceRequests.referenceNumber,
      issueType: serviceRequests.issueType,
      urgency: serviceRequests.urgency,
      description: serviceRequests.description,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
      addressEncrypted: serviceRequests.addressEncrypted,
      accessNotes: serviceRequests.accessNotes,
    })
    .from(serviceRequests)
    .leftJoin(customers, eq(serviceRequests.customerId, customers.id))
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.id, requestId),
      ),
    );

  if (!row) {
    return null;
  }

  return {
    requestId: row.requestId,
    hcpJobId: row.hcpJobId,
    customerId: row.customerId,
    hcpCustomerId: row.hcpCustomerId,
    jobFields: {
      referenceNumber: row.referenceNumber,
      issueType: row.issueType,
      urgency: row.urgency,
      description: row.description,
      arrivalWindowStart: row.arrivalWindowStart,
      arrivalWindowEnd: row.arrivalWindowEnd,
      addressText: safeDecrypt(row.addressEncrypted),
      accessNotes: row.accessNotes,
    },
  };
}

/**
 * Push a confirmed request into Housecall Pro as a job, or UPDATE the existing
 * HCP job when one is already mapped. Best-effort + idempotent:
 *
 *  - No-ops when the org isn't HCP-connected (no client) or the request doesn't
 *    exist in the org.
 *  - Ensures the customer is mirrored to HCP first (Stage 2). No-ops when the
 *    request has no customer, or the customer couldn't be mapped to HCP.
 *  - If hcp_job_id is set: UPDATE that HCP job (reschedule/re-describe).
 *  - Otherwise: CREATE an HCP job and persist its id with a guard
 *    (... AND hcp_job_id IS NULL) so two concurrent pushes can't create two jobs.
 *
 * Any HCP/network error is logged at WARN and swallowed — never thrown.
 * `fetchImpl` is injectable so tests mock the network and never hit the real API.
 */
export async function pushJobToHcp(
  organizationId: string,
  serviceRequestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const client = await getHousecallClient(organizationId, fetchImpl);
  if (!client) {
    return; // org not HCP-connected (no key) — safe no-op
  }

  try {
    const initial = await loadJobSyncRow(organizationId, serviceRequestId);
    if (!initial) {
      return; // unknown request — nothing to push
    }

    // Already mapped → UPDATE the existing HCP job and stop (idempotent path).
    if (initial.hcpJobId) {
      const fields = serviceRequestToJobFields(initial.jobFields);
      await client.updateJob(initial.hcpJobId, {
        description: fields.description,
        scheduleStart: fields.scheduleStart,
        scheduleEnd: fields.scheduleEnd,
      });
      logger.info(
        { organizationId, serviceRequestId, hcpJobId: initial.hcpJobId },
        "Updated Housecall Pro job",
      );
      return;
    }

    if (!initial.customerId) {
      return; // no customer to key the job to — nothing to push
    }

    // Ensure the customer is mirrored to HCP first (Stage 2). It's idempotent
    // and degrade-safe; afterwards we RE-READ to pick up the freshly written
    // hcp_customer_id rather than trusting our stale snapshot.
    await syncCustomerToHcp(organizationId, initial.customerId, fetchImpl);

    const row = await loadJobSyncRow(organizationId, serviceRequestId);
    if (!row) {
      return;
    }
    // A concurrent push may have created the job between our reads — re-check.
    if (row.hcpJobId) {
      return;
    }
    if (!row.hcpCustomerId) {
      // Customer couldn't be mapped to HCP (no contact, or HCP error) — we
      // can't key a job to a customer. Degrade: skip, a later push retries.
      logger.warn(
        { organizationId, serviceRequestId, customerId: row.customerId },
        "Housecall Pro job push skipped: customer not mapped to HCP",
      );
      return;
    }

    const fields = serviceRequestToJobFields(row.jobFields);
    const job = await client.createJob({
      customerId: row.hcpCustomerId,
      description: fields.description,
      scheduleStart: fields.scheduleStart,
      scheduleEnd: fields.scheduleEnd,
      requestId: serviceRequestId,
    });

    // Persist the mapping, guarded on hcp_job_id IS NULL so a racing push that
    // already wrote an id is never overwritten (avoids a duplicate mapping).
    await db
      .update(serviceRequests)
      .set({ hcpJobId: job.id, updatedAt: new Date() })
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.id, serviceRequestId),
          isNull(serviceRequests.hcpJobId),
        ),
      );

    logger.info(
      { organizationId, serviceRequestId, hcpJobId: job.id },
      "Created Housecall Pro job",
    );
  } catch (error: unknown) {
    // Degrade: an HCP failure must not surface to the booking/scheduling flow.
    logger.warn(
      { organizationId, serviceRequestId, error },
      "Housecall Pro job push failed (degraded)",
    );
  }
}

/**
 * Cancel the HCP job for a cancelled request. No-ops when the org isn't
 * connected, the request doesn't exist, or it has no mapped HCP job. The HCP id
 * is left on the row for the audit trail (the job is harmless once cancelled).
 *
 * Same degrade-safe contract as {@link pushJobToHcp}: any HCP error is logged +
 * swallowed.
 */
export async function cancelHcpJob(
  organizationId: string,
  serviceRequestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const client = await getHousecallClient(organizationId, fetchImpl);
  if (!client) {
    return; // org not HCP-connected — safe no-op
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
      return; // no mapped HCP job — nothing to cancel
    }

    await client.cancelJob(row.hcpJobId);
    logger.info(
      { organizationId, serviceRequestId, hcpJobId: row.hcpJobId },
      "Cancelled Housecall Pro job",
    );
  } catch (error: unknown) {
    logger.warn(
      { organizationId, serviceRequestId, error },
      "Housecall Pro job cancel failed (degraded)",
    );
  }
}
