/**
 * JOB SYNC: push a confirmed service request into Fieldpulse as a job, and
 * keep that Fieldpulse job in lockstep as our schedule changes or the request is
 * cancelled.
 *
 * Mirrors housecall-pro/job-sync.ts: called from route `after()` background
 * tasks — NEVER on the response path. The golden rule is DEGRADE SAFELY: every
 * path no-ops (logging at most a warning) when the org isn't Fieldpulse-connected,
 * the request doesn't exist, or Fieldpulse returns an error.
 *
 * IDEMPOTENT: the Fieldpulse job id is stored on service_requests.fieldpulse_job_id.
 * Once set, a re-push UPDATEs the existing Fieldpulse job (reschedule/re-describe)
 * rather than creating a duplicate. The push first ensures the customer is mirrored
 * to Fieldpulse so the job can be keyed to a Fieldpulse customer id.
 *
 * The API key is never logged; PII is decrypted only in memory for the FP body.
 */
import { eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { customers, serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { getFieldpulseClient } from "./client";
import { syncCustomerToFieldpulse } from "./customer-sync";
import { serviceRequestToJobFields } from "./job-mapping";

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
  readonly fieldpulseJobId: string | null;
  readonly customerId: string | null;
  readonly fieldpulseCustomerId: string | null;
  readonly jobFields: {
    readonly referenceNumber: string;
    readonly issueType: string;
    readonly urgency: string;
    readonly description: string;
    readonly arrivalWindowStart: Date | null;
    readonly arrivalWindowEnd: Date | null;
    readonly addressText: string | null;
    readonly accessNotes: string | null;
    readonly jobType?: string | null;
    readonly systemType?: string | null;
  };
}

/**
 * Load one request joined to its CRM customer (for the FP customer id), tenant-
 * scoped. Returns null when the request doesn't exist. PII is decrypted here, in
 * memory, only for the FP job body.
 */
async function loadJobSyncRow(
  organizationId: string,
  requestId: string,
): Promise<JobSyncRow | null> {
  const [row] = await db
    .select({
      requestId: serviceRequests.id,
      fieldpulseJobId: serviceRequests.fieldpulseJobId,
      customerId: serviceRequests.customerId,
      fieldpulseCustomerId: customers.fieldpulseCustomerId,
      referenceNumber: serviceRequests.referenceNumber,
      issueType: serviceRequests.issueType,
      urgency: serviceRequests.urgency,
      description: serviceRequests.description,
      jobType: serviceRequests.jobType,
      systemType: serviceRequests.systemType,
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
    fieldpulseJobId: row.fieldpulseJobId,
    customerId: row.customerId,
    fieldpulseCustomerId: row.fieldpulseCustomerId,
    jobFields: {
      referenceNumber: row.referenceNumber,
      issueType: row.issueType,
      urgency: row.urgency,
      description: row.description,
      jobType: row.jobType,
      systemType: row.systemType,
      arrivalWindowStart: row.arrivalWindowStart,
      arrivalWindowEnd: row.arrivalWindowEnd,
      addressText: safeDecrypt(row.addressEncrypted),
      accessNotes: row.accessNotes,
    },
  };
}

/**
 * Push a confirmed request into Fieldpulse as a job, or UPDATE the existing
 * Fieldpulse job when one is already mapped. Best-effort + idempotent:
 *
 *  - No-ops when the org isn't Fieldpulse-connected (no client) or the request
 *    doesn't exist in the org.
 *  - Ensures the customer is mirrored to Fieldpulse first. No-ops when the
 *    request has no customer, or the customer couldn't be mapped to Fieldpulse.
 *  - If fieldpulse_job_id is set: UPDATE that Fieldpulse job (reschedule).
 *  - Otherwise: CREATE a Fieldpulse job and persist its id with a guard
 *    (... AND fieldpulse_job_id IS NULL) so two concurrent pushes can't create
 *    two jobs.
 *
 * Any Fieldpulse/network error is logged at WARN and swallowed — never thrown.
 * `fetchImpl` is injectable so tests mock the network and never hit the real API.
 */
export async function pushJobToFieldpulse(
  organizationId: string,
  serviceRequestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const client = await getFieldpulseClient(organizationId, fetchImpl);
  if (!client) {
    return; // org not Fieldpulse-connected — safe no-op
  }

  try {
    const initial = await loadJobSyncRow(organizationId, serviceRequestId);
    if (!initial) {
      return; // unknown request — nothing to push
    }

    // Already mapped → UPDATE the existing Fieldpulse job and stop (idempotent path).
    if (initial.fieldpulseJobId) {
      const fields = serviceRequestToJobFields(initial.jobFields);
      await client.updateJob(initial.fieldpulseJobId, {
        description: fields.description,
        scheduleStart: fields.scheduleStart,
        scheduleEnd: fields.scheduleEnd,
      });
      logger.info(
        { organizationId, serviceRequestId, fieldpulseJobId: initial.fieldpulseJobId },
        "Updated Fieldpulse job",
      );
      return;
    }

    if (!initial.customerId) {
      return; // no customer to key the job to — nothing to push
    }

    // Ensure the customer is mirrored to Fieldpulse first. It's idempotent
    // and degrade-safe; afterwards we RE-READ to pick up the freshly written
    // fieldpulse_customer_id rather than trusting our stale snapshot.
    await syncCustomerToFieldpulse(organizationId, initial.customerId, fetchImpl);

    const row = await loadJobSyncRow(organizationId, serviceRequestId);
    if (!row) {
      return;
    }
    // A concurrent push may have created the job between our reads — re-check.
    if (row.fieldpulseJobId) {
      return;
    }
    if (!row.fieldpulseCustomerId) {
      // Customer couldn't be mapped to Fieldpulse — we can't key a job to a
      // customer. Degrade: skip, a later push retries.
      logger.warn(
        { organizationId, serviceRequestId, customerId: row.customerId },
        "Fieldpulse job push skipped: customer not mapped to Fieldpulse",
      );
      return;
    }

    const fields = serviceRequestToJobFields(row.jobFields);
    const job = await client.createJob({
      customerId: row.fieldpulseCustomerId,
      description: fields.description,
      scheduleStart: fields.scheduleStart,
      scheduleEnd: fields.scheduleEnd,
      requestId: serviceRequestId,
    });

    // Persist the mapping, guarded on fieldpulse_job_id IS NULL so a racing push
    // that already wrote an id is never overwritten.
    await db
      .update(serviceRequests)
      .set({ fieldpulseJobId: job.id, updatedAt: new Date() })
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.id, serviceRequestId),
          isNull(serviceRequests.fieldpulseJobId),
        ),
      );

    logger.info(
      { organizationId, serviceRequestId, fieldpulseJobId: job.id },
      "Created Fieldpulse job",
    );
  } catch (error: unknown) {
    // Degrade: a Fieldpulse failure must not surface to the booking/scheduling flow.
    logger.warn(
      { organizationId, serviceRequestId, error },
      "Fieldpulse job push failed (degraded)",
    );
  }
}

/**
 * Cancel the Fieldpulse job for a cancelled request. No-ops when the org isn't
 * connected, the request doesn't exist, or it has no mapped Fieldpulse job. The
 * Fieldpulse id is left on the row for the audit trail.
 *
 * Same degrade-safe contract as {@link pushJobToFieldpulse}: any Fieldpulse error
 * is logged + swallowed.
 */
export async function cancelFieldpulseJob(
  organizationId: string,
  serviceRequestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const client = await getFieldpulseClient(organizationId, fetchImpl);
  if (!client) {
    return; // org not Fieldpulse-connected — safe no-op
  }

  try {
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
      return; // no mapped Fieldpulse job — nothing to cancel
    }

    await client.cancelJob(row.fieldpulseJobId);
    logger.info(
      { organizationId, serviceRequestId, fieldpulseJobId: row.fieldpulseJobId },
      "Cancelled Fieldpulse job",
    );
  } catch (error: unknown) {
    logger.warn(
      { organizationId, serviceRequestId, error },
      "Fieldpulse job cancel failed (degraded)",
    );
  }
}
