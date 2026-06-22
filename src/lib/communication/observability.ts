/**
 * Comms-outcome observability.
 *
 * Read-only, tenant-scoped summary of the communication queue's outcomes so an
 * admin can see comms HEALTH at a glance:
 *   - sent / failed / pending counts (the queue's terminal + in-flight states),
 *   - WHY jobs were suppressed: the consent gate cancels jobs with
 *     errorMessage `suppressed:<reason>` — bucketed here by reason,
 *   - the RESEND-unset stall: email jobs left 'pending' because RESEND_API_KEY
 *     is not configured (job-queue declines to claim email jobs in that case).
 *
 * No PII: we read only status/channel/errorMessage (errorMessage on cancelled
 * jobs is the `suppressed:<reason>` enum tag, never recipient data).
 */
import { gte } from "drizzle-orm";
import { db } from "@/lib/db";
import { communicationJobs } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface CommsOutcomeSummary {
  readonly sent: number;
  readonly failed: number;
  readonly pending: number;
  /** Cancelled jobs bucketed by the consent gate's `suppressed:<reason>` tag. */
  readonly suppressedByReason: Record<string, number>;
  /** Email jobs stuck at 'pending' (the RESEND_API_KEY-unset stall). */
  readonly emailStalled: number;
}

const SUPPRESSED_PREFIX = "suppressed:";

/**
 * Summarize an org's communication-job outcomes, optionally limited to jobs
 * created at/after `sinceMs` (epoch millis). Tenant-scoped.
 */
export async function getCommsOutcomeSummary(
  organizationId: string,
  sinceMs?: number,
): Promise<CommsOutcomeSummary> {
  const sinceFilter =
    sinceMs !== undefined
      ? [gte(communicationJobs.createdAt, new Date(sinceMs))]
      : [];

  const rows = await db
    .select({
      status: communicationJobs.status,
      channel: communicationJobs.channel,
      errorMessage: communicationJobs.errorMessage,
    })
    .from(communicationJobs)
    .where(withTenant(communicationJobs, organizationId, ...sinceFilter));

  let sent = 0;
  let failed = 0;
  let pending = 0;
  let emailStalled = 0;
  const suppressedByReason: Record<string, number> = {};

  for (const row of rows) {
    switch (row.status) {
      case "sent":
        sent++;
        break;
      case "failed":
        failed++;
        break;
      case "pending":
        pending++;
        // The RESEND-unset stall: an email job that never gets claimed.
        if (row.channel === "email") emailStalled++;
        break;
      case "cancelled": {
        // The consent gate writes `suppressed:<reason>`; bucket by reason.
        const msg = row.errorMessage ?? "";
        if (msg.startsWith(SUPPRESSED_PREFIX)) {
          const reason = msg.slice(SUPPRESSED_PREFIX.length) || "unknown";
          suppressedByReason[reason] = (suppressedByReason[reason] ?? 0) + 1;
        }
        break;
      }
      default:
        // 'processing' (in-flight) is neither a terminal nor a stall — ignore.
        break;
    }
  }

  return { sent, failed, pending, suppressedByReason, emailStalled };
}
