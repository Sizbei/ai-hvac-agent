/**
 * Communication Job Queue
 *
 * In-memory job queue for processing communication jobs.
 * Uses Vercel cron for periodic job processing.
 *
 * IMPORTANT: This queue is designed for Vercel serverless environment.
 * Jobs are processed by after() hooks (non-blocking) and scheduled via Vercel cron.
 */

import { db } from "@/lib/db";
import { communicationJobs, communicationTemplates, communicationChannelEnum, communicationJobStatusEnum } from "@/lib/db/schema";
import { eq, and, lt, lte, asc } from "drizzle-orm";
import { encrypt, decrypt } from "@/lib/crypto";
import { checkSendAllowed } from "./consent";
import { sendSms } from "./twilio-adapter";
import { getResend } from "./resend-adapter";
import { renderSmsTemplate } from "./sms-templates";
import { renderEmailTemplate } from "./email-templates";

/**
 * Queue a new communication job
 *
 * @param job - Job details
 * @returns Created job ID
 */
export async function queueCommunicationJob(job: {
  organizationId: string;
  templateId: string;
  triggerType: string;
  channel: typeof communicationChannelEnum;
  recipientPhone?: string;
  recipientEmail?: string;
  templateVariables: Record<string, unknown>;
  scheduledFor?: Date;
  priority?: number;
  customerId?: string;
  serviceRequestId?: string;
}): Promise<string> {
  const [created] = await db
    .insert(communicationJobs)
    .values({
      organizationId: job.organizationId,
      templateId: job.templateId,
      triggerType: job.triggerType as any,
      channel: job.channel as any,
      status: "pending" as any,
      priority: job.priority ?? 50,
      // Encrypt recipient PII at rest.
      recipientPhoneEncrypted: job.recipientPhone ? encrypt(job.recipientPhone) : null,
      recipientEmailEncrypted: job.recipientEmail ? encrypt(job.recipientEmail) : null,
      templateVariables: job.templateVariables as any,
      scheduledFor: job.scheduledFor ?? new Date(),
      customerId: job.customerId,
      serviceRequestId: job.serviceRequestId,
    })
    .returning({ id: communicationJobs.id });

  return created.id;
}

/**
 * Process pending communication jobs
 *
 * This function is called by Vercel cron every minute.
 * It picks up pending jobs that are due to be sent and processes them.
 *
 * @param limit - Maximum number of jobs to process in one batch (default: 10)
 * @returns Number of jobs processed
 */
export async function processPendingJobs(limit = 10): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  const now = new Date();

  // Fetch pending jobs that are scheduled for now or earlier
  const pendingJobs = await db
    .select()
    .from(communicationJobs)
    .where(
      and(
        eq(communicationJobs.status, "pending"),
        lte(communicationJobs.scheduledFor, now),
      ),
    )
    .orderBy(asc(communicationJobs.scheduledFor), asc(communicationJobs.priority))
    .limit(limit);

  if (pendingJobs.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  let succeeded = 0;
  let failed = 0;

  // If email isn't configured, do NOT claim email jobs: claiming then failing
  // on getResend() would burn maxAttempts and silently drop every email. Leave
  // them pending so they flush once RESEND_API_KEY is set. Warn once per drain.
  const emailConfigured = Boolean(process.env.RESEND_API_KEY?.trim());
  let warnedEmailDisabled = false;

  // Process each job
  for (const job of pendingJobs) {
    try {
      if (job.channel === "email" && !emailConfigured) {
        if (!warnedEmailDisabled) {
          console.warn(
            "[job-queue] RESEND_API_KEY not set — skipping email jobs (left pending, not failed). Set the key to flush them.",
          );
          warnedEmailDisabled = true;
        }
        continue;
      }

      // CONSENT GATE (TCPA/CAN-SPAM): the send chokepoint. A do-not-contact
      // customer, a disabled channel/type, or quiet hours suppresses the send —
      // the job is cancelled, never delivered. Checked at SEND time (not just
      // enqueue) so a consent change after enqueue is honored.
      const decision = await checkSendAllowed({
        organizationId: job.organizationId,
        customerId: job.customerId,
        channel: job.channel,
        triggerType: job.triggerType,
      });
      if (!decision.allowed) {
        await db
          .update(communicationJobs)
          .set({
            status: "cancelled",
            completedAt: new Date(),
            errorMessage: `suppressed:${decision.reason}`,
          })
          .where(eq(communicationJobs.id, job.id));
        continue;
      }

      // ATOMICALLY claim the job: flip pending->processing guarded on the
      // current status + RETURNING. If a concurrent cron drain already claimed
      // it, this matches zero rows and we skip — so re-running the cron (or two
      // overlapping invocations) sends each job exactly once.
      const [claimed] = await db
        .update(communicationJobs)
        .set({
          status: "processing",
          startedAt: new Date(),
          attempts: job.attempts + 1,
        })
        .where(
          and(
            eq(communicationJobs.id, job.id),
            eq(communicationJobs.status, "pending"),
          ),
        )
        .returning({ id: communicationJobs.id });

      if (!claimed) {
        continue; // another drain already took this job
      }

      // Send the communication
      await sendCommunication(job);

      // Mark as sent
      await db
        .update(communicationJobs)
        .set({
          status: "sent",
          completedAt: new Date(),
        })
        .where(eq(communicationJobs.id, job.id));

      succeeded++;
    } catch (error) {
      console.error(`Failed to process communication job ${job.id}:`, error);

      // Check if we should retry
      const shouldRetry = job.attempts + 1 < job.maxAttempts;

      await db
        .update(communicationJobs)
        .set({
          status: "failed",
          errorMessage:
            error instanceof Error ? error.message : "Unknown error",
          completedAt: shouldRetry ? null : new Date(),
        })
        .where(eq(communicationJobs.id, job.id));

      if (!shouldRetry) {
        failed++;
      } else {
        // Schedule retry with exponential backoff
        const retryDelay = Math.pow(2, job.attempts) * 60000; // 1min, 2min, 4min...
        await db
          .update(communicationJobs)
          .set({
            scheduledFor: new Date(Date.now() + retryDelay),
          })
          .where(eq(communicationJobs.id, job.id));
      }
    }
  }

  return { processed: pendingJobs.length, succeeded, failed };
}

/**
 * Send a single communication
 *
 * @param job - Communication job with template
 * @throws Error if sending fails
 */
async function sendCommunication(
  job: typeof communicationJobs.$inferSelect,
): Promise<void> {
  // Fetch the template
  const template = await db.query.communicationTemplates.findFirst({
    where: eq(communicationTemplates.id, job.templateId),
  });

  if (!template) {
    throw new Error(`Template not found: ${job.templateId}`);
  }

  // Render the message
  const variables = job.templateVariables as Record<string, unknown>;

  // Decrypt recipient PII in-memory only (stored encrypted at rest).
  const recipientPhone = job.recipientPhoneEncrypted
    ? decrypt(job.recipientPhoneEncrypted)
    : null;
  const recipientEmail = job.recipientEmailEncrypted
    ? decrypt(job.recipientEmailEncrypted)
    : null;

  switch (job.channel) {
    case "sms": {
      if (!recipientPhone) {
        throw new Error("SMS recipient phone number is required");
      }

      const message = renderSmsTemplate(template.bodyTemplate, variables);

      // Send via Twilio
      const result = await sendSms({
        to: recipientPhone,
        body: message,
      });

      // Store external ID for delivery status tracking
      await db
        .update(communicationJobs)
        .set({ externalId: result.sid })
        .where(eq(communicationJobs.id, job.id));

      break;
    }

    case "email": {
      if (!recipientEmail) {
        throw new Error("Email recipient address is required");
      }

      // Render HTML email
      // For now, use the text template as body (full React Email integration in Phase 2)
      const subject = template.subjectTemplate || "Notification";
      const body = renderSmsTemplate(template.bodyTemplate, variables);

      // Send via Resend
      const result = await getResend().emails.send({
        from: "notifications@spears-services.com", // TODO: Make configurable per org
        to: recipientEmail,
        subject,
        html: `<p>${body}</p>`, // Simple HTML wrapper for now
      });

      // Store external ID (Resend returns different structure, check for error first)
      if ("error" in result && result.error) {
        throw new Error(result.error.message);
      }
      // Extract the email ID from successful response
      const emailId = "data" in result && result.data?.id;
      if (emailId) {
        await db
          .update(communicationJobs)
          .set({ externalId: emailId })
          .where(eq(communicationJobs.id, job.id));
      }

      break;
    }

    case "voice": {
      // Voice calls will be implemented in Phase 3 (escalation)
      throw new Error("Voice channel not yet implemented");
    }

    default:
      throw new Error(`Unknown channel: ${job.channel}`);
  }
}

/**
 * Retry failed jobs
 *
 * Called by Vercel cron to retry failed jobs whose retry time has arrived.
 *
 * @param limit - Maximum number of jobs to retry (default: 5)
 * @returns Number of jobs retried
 */
export async function retryFailedJobs(limit = 5): Promise<number> {
  const now = new Date();

  const failedJobs = await db
    .select()
    .from(communicationJobs)
    .where(
      and(
        eq(communicationJobs.status, "failed"),
        lt(communicationJobs.scheduledFor, now),
        lt(communicationJobs.attempts, communicationJobs.maxAttempts),
      ),
    )
    .orderBy(asc(communicationJobs.scheduledFor))
    .limit(limit);

  for (const job of failedJobs) {
    // Reset to pending so the main processor picks it up
    await db
      .update(communicationJobs)
      .set({ status: "pending" as any })
      // Guard on status='failed' so two concurrent retry drains can't both
      // reset the same job (latent double-reset).
      .where(
        and(
          eq(communicationJobs.id, job.id),
          eq(communicationJobs.status, "failed"),
        ),
      );
  }

  return failedJobs.length;
}

/**
 * Cancel a pending job
 *
 * @param jobId - Job ID to cancel
 * @returns true if cancelled, false if not found or already processed
 */
export async function cancelCommunicationJob(jobId: string): Promise<boolean> {
  const result = await db
    .update(communicationJobs)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(communicationJobs.id, jobId),
        eq(communicationJobs.status, "pending"),
      ),
    );

  return result.rowCount > 0;
}

/**
 * Get job status
 *
 * @param jobId - Job ID
 * @returns Job status or null if not found
 */
export async function getCommunicationJobStatus(jobId: string): Promise<{
  id: string;
  status: string;
  attempts: number;
  errorMessage?: string;
  externalId?: string;
} | null> {
  const job = await db.query.communicationJobs.findFirst({
    where: eq(communicationJobs.id, jobId),
    columns: {
      id: true,
      status: true,
      attempts: true,
      errorMessage: true,
      externalId: true,
    },
  });

  if (!job) return null;

  return {
    id: job.id,
    status: job.status,
    attempts: job.attempts,
    errorMessage: job.errorMessage ?? undefined,
    externalId: job.externalId ?? undefined,
  };
}
