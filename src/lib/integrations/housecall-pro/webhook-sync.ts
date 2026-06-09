/**
 * Apply an inbound Housecall Pro webhook to our domain. (Stage 5 — HCP -> us.)
 *
 * This is the back half of the webhook handler, kept out of the route so it's
 * unit-testable without HTTP. Given an ALREADY-VERIFIED, parsed event it:
 *
 *   1. DEDUPES on the HCP event id (idempotency ledger). HCP retries delivery,
 *      so the same event can arrive twice; we insert the ledger row
 *      onConflictDoNothing and stop if it was already there — a redelivery
 *      applies no second update.
 *   2. Maps the event type to a request-status target (webhook-events.ts) and,
 *      when there is one, finds OUR service_request by hcp_job_id (tenant-scoped)
 *      and transitions it through the SAME state machine + guard the dispatcher
 *      UI uses (queries.updateRequestStatus) — so an illegal edge (e.g. a
 *      late "scheduled" for an already-completed job) is rejected, never forced.
 *   3. AUDITS the outcome (applied / skipped / no-op) with non-PII details.
 *   4. On a completion, fires the existing follow-up mechanism in the BACKGROUND
 *      via after() (reuses addFollowUp + a service_history row) so a completed
 *      service schedules a courtesy follow-up without blocking the webhook ack.
 *
 * DEGRADE-SAFE: an unknown job id, an unmapped event type, or an illegal
 * transition are all recorded and 200'd (we don't want HCP to retry forever on
 * something we've intentionally ignored). The signature was already verified by
 * the caller; this module never touches secrets.
 */
import { after } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  auditLog,
  hcpWebhookEvents,
  serviceHistory,
  serviceRequests,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { updateRequestStatus } from "@/lib/admin/queries";
import { addFollowUp } from "@/lib/admin/crm-queries";
import { logger } from "@/lib/logger";
import {
  eventTypeToInvoiceStatus,
  eventTypeToStatus,
  type HcpWebhookEvent,
} from "./webhook-events";

/** Days after a completed service to schedule the courtesy follow-up. */
const FOLLOW_UP_DELAY_DAYS = 30;
const FOLLOW_UP_REASON = "Post-service follow-up (Housecall Pro job completed)";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The outcome of applying one webhook event — drives the audit detail + log. */
export type WebhookApplyOutcome =
  | "applied"
  | "duplicate"
  | "unmapped_event"
  | "unknown_job"
  | "invalid_transition";

export interface WebhookApplyResult {
  readonly outcome: WebhookApplyOutcome;
}

/**
 * Record the event in the idempotency ledger. Returns true when THIS call
 * inserted the row (first delivery), false when it already existed (redelivery).
 * The unique (org, event_id) index makes this atomic across concurrent
 * redeliveries — exactly one insert wins.
 */
async function recordEventOnce(
  organizationId: string,
  event: HcpWebhookEvent,
): Promise<boolean> {
  const inserted = await db
    .insert(hcpWebhookEvents)
    .values({
      organizationId,
      eventId: event.eventId,
      eventType: event.eventType,
      hcpJobId: event.hcpJobId,
    })
    .onConflictDoNothing({
      target: [hcpWebhookEvents.organizationId, hcpWebhookEvents.eventId],
    })
    .returning({ id: hcpWebhookEvents.id });
  return inserted.length > 0;
}

/**
 * Compensating delete of the idempotency ledger row, used ONLY when processing
 * threw AFTER we claimed the event. Without this, a transient failure (e.g. a DB
 * blip during the status update) would leave the ledger row behind, so HCP's
 * retry of the SAME event id would be deduped as "already processed" and the
 * update would be lost forever. Releasing the claim lets the retry reprocess.
 * Best-effort: a failed release just means the retry is deduped (the pre-existing
 * behaviour), so a release error is logged, never thrown. Tenant-scoped.
 */
async function releaseEvent(
  organizationId: string,
  event: HcpWebhookEvent,
): Promise<void> {
  await db
    .delete(hcpWebhookEvents)
    .where(
      withTenant(
        hcpWebhookEvents,
        organizationId,
        eq(hcpWebhookEvents.eventId, event.eventId),
      ),
    )
    .catch((error: unknown) => {
      logger.error(
        { error, organizationId, eventId: event.eventId },
        "Failed to release HCP webhook ledger row after a processing error",
      );
    });
}

/**
 * Audit a webhook outcome (best-effort; never throws into the caller). A webhook
 * has no admin user and no customer session, so we insert the audit row directly
 * with user_id left NULL (it's a nullable FK to users) rather than via logAudit,
 * which requires a userId — same precedent as the session-confirm audit. The
 * machine actor is conveyed by the `action` prefix. Details stay non-PII (ids +
 * enums only), per the audit-detail policy.
 */
async function auditOutcome(
  organizationId: string,
  event: HcpWebhookEvent,
  outcome: WebhookApplyOutcome,
  requestId: string | null,
): Promise<void> {
  await db
    .insert(auditLog)
    .values({
      organizationId,
      action: "hcp_webhook_received",
      entity: "service_requests",
      entityId: requestId ?? null,
      details: JSON.stringify({
        eventId: event.eventId,
        eventType: event.eventType,
        hcpJobId: event.hcpJobId,
        outcome,
      }),
    })
    .catch((error: unknown) => {
      logger.error({ error, organizationId }, "Failed to audit HCP webhook");
    });
}

/**
 * Apply one verified, parsed HCP webhook event to our domain. Idempotent on the
 * event id; degrade-safe on every miss. See module doc for the full contract.
 */
export async function applyWebhookEvent(
  organizationId: string,
  event: HcpWebhookEvent,
): Promise<WebhookApplyResult> {
  // 1. Idempotency: only the FIRST delivery of this event id proceeds.
  const isFirst = await recordEventOnce(organizationId, event);
  if (!isFirst) {
    logger.info(
      { organizationId, eventId: event.eventId },
      "HCP webhook redelivery ignored (already processed)",
    );
    return { outcome: "duplicate" };
  }

  // Everything below MAY throw on a transient DB failure. Because we've already
  // claimed the event in the ledger, a throw here would otherwise make HCP's
  // retry dedupe as "duplicate" and silently drop the update. So on any
  // unexpected error we RELEASE the ledger claim, then rethrow so the route
  // 500s and HCP retries the (now reprocessable) event. Terminal outcomes
  // returned below intentionally KEEP the ledger row — retrying them won't
  // change anything.
  try {
    // 2a. Invoice events: mirror the invoice/payment status onto the matching
    //     request (linked by hcpJobId). Independent of the job-status state
    //     machine — an invoice event never drives a request-status transition.
    //     Unknown/unlinkable invoice events are recorded + no-op'd.
    const invoiceStatus = eventTypeToInvoiceStatus(event.eventType);
    if (invoiceStatus) {
      return await applyInvoiceEvent(organizationId, event, invoiceStatus);
    }

    // 2. Map the event type to a request-status target. Unknown/non-lifecycle
    //    events are recorded (above) but drive no transition.
    const target = eventTypeToStatus(event.eventType);
    if (!target || !event.hcpJobId) {
      await auditOutcome(organizationId, event, "unmapped_event", null);
      return { outcome: "unmapped_event" };
    }

    // Find OUR service_request mapped to this HCP job (tenant-scoped).
    const [row] = await db
      .select({
        id: serviceRequests.id,
        customerId: serviceRequests.customerId,
      })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.hcpJobId, event.hcpJobId),
        ),
      );

    if (!row) {
      // The job exists in HCP but we never mapped it (created outside our flow,
      // or a stale id). Recorded + 200'd so HCP stops retrying; nothing to do.
      logger.warn(
        { organizationId, hcpJobId: event.hcpJobId, eventType: event.eventType },
        "HCP webhook for unknown job id",
      );
      await auditOutcome(organizationId, event, "unknown_job", null);
      return { outcome: "unknown_job" };
    }

    // 3. Transition through the shared state machine + DB guard. An illegal edge
    //    from the request's CURRENT status is rejected here — never forced.
    const result = await updateRequestStatus(organizationId, row.id, target);
    if (!result.ok) {
      logger.info(
        {
          organizationId,
          requestId: row.id,
          target,
          reason: result.reason,
          currentStatus:
            result.reason === "invalid_transition"
              ? result.currentStatus
              : null,
        },
        "HCP webhook transition rejected by state machine",
      );
      await auditOutcome(organizationId, event, "invalid_transition", row.id);
      return { outcome: "invalid_transition" };
    }

    await auditOutcome(organizationId, event, "applied", row.id);

    // 4. Follow-up on completion — reuse the existing follow-up mechanism, in
    //    the background so the webhook ack isn't blocked. Best-effort: a
    //    follow-up failure must not fail the (already-applied) status update,
    //    and after() defers the callback, so registering it can't throw here.
    if (target === "completed" && row.customerId) {
      const customerId = row.customerId;
      const requestId = row.id;
      after(async () => {
        try {
          await scheduleCompletionFollowUp(
            organizationId,
            customerId,
            requestId,
          );
        } catch (error: unknown) {
          logger.error(
            { error, organizationId, requestId },
            "HCP completion follow-up failed (non-fatal)",
          );
        }
      });
    }

    logger.info(
      { organizationId, requestId: row.id, target },
      "HCP webhook applied status update",
    );
    return { outcome: "applied" };
  } catch (error: unknown) {
    // A throw AFTER claiming the ledger would otherwise make HCP's retry dedupe
    // and drop the update. Release the claim, then rethrow so the route 500s
    // and HCP retries the (now reprocessable) event.
    await releaseEvent(organizationId, event);
    throw error;
  }
}

/**
 * Apply an HCP invoice event by mirroring its status onto the matching service
 * request (found by hcpJobId, tenant-scoped) via a single conditional UPDATE.
 * Degrade-safe: an unlinkable event (no request maps to the job, or it has no
 * job id) updates zero rows and is recorded as a no-op. Idempotency is already
 * handled by the caller's ledger claim, so a re-delivered event never reaches
 * here; even if it did, setting the same status again would be a harmless write.
 * Returns the terminal outcome; the ledger row is kept (retrying changes nothing).
 */
async function applyInvoiceEvent(
  organizationId: string,
  event: HcpWebhookEvent,
  invoiceStatus: "sent" | "paid" | "void",
): Promise<WebhookApplyResult> {
  if (!event.hcpJobId) {
    await auditOutcome(organizationId, event, "unknown_job", null);
    return { outcome: "unknown_job" };
  }

  const updated = await db
    .update(serviceRequests)
    .set({ invoiceStatus })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.hcpJobId, event.hcpJobId),
      ),
    )
    .returning({ id: serviceRequests.id });

  const row = updated[0];
  if (!row) {
    logger.warn(
      { organizationId, hcpJobId: event.hcpJobId, eventType: event.eventType },
      "HCP invoice webhook for unknown job id",
    );
    await auditOutcome(organizationId, event, "unknown_job", null);
    return { outcome: "unknown_job" };
  }

  await auditOutcome(organizationId, event, "applied", row.id);
  logger.info(
    { organizationId, requestId: row.id, invoiceStatus },
    "HCP invoice webhook applied invoice status",
  );
  return { outcome: "applied" };
}

/**
 * On a webhook-driven completion, reuse the existing follow-up mechanism: a
 * pending follow-up due in {@link FOLLOW_UP_DELAY_DAYS} days plus a
 * service_history row marking the completed service (followUpNeeded=true).
 * Exported for direct testing.
 */
export async function scheduleCompletionFollowUp(
  organizationId: string,
  customerId: string,
  serviceRequestId: string,
): Promise<void> {
  const dueDate = new Date(Date.now() + FOLLOW_UP_DELAY_DAYS * MS_PER_DAY);

  await addFollowUp(organizationId, customerId, {
    reason: FOLLOW_UP_REASON,
    dueDate: dueDate.toISOString(),
  });

  await db.insert(serviceHistory).values({
    customerId,
    serviceRequestId,
    organizationId,
    workPerformed: "Service completed (synced from Housecall Pro)",
    followUpNeeded: true,
    followUpDate: dueDate,
  });
}
