/**
 * Outbound-send dedupe ledger.
 *
 * Cron-driven customer messaging (warranty-expiry, booking-recovery, renewal
 * nudges — Stages 5/6/10) runs on retry-prone Vercel crons. Without a dedupe
 * primitive a retried cron double-sends. claimOutboundOnce atomically claims a
 * (org, customer, trigger, period) slot via the unique index: the FIRST caller
 * gets true and should send; any duplicate gets false and must skip.
 */
import { db } from "@/lib/db";
import { outboundMessageLedger } from "@/lib/db/schema";
import type { CommTrigger } from "./consent";

/**
 * Atomically claim one outbound send. Returns true exactly once per
 * (organizationId, customerId, triggerType, periodKey) — the caller that gets
 * true should send; everyone else (a retry/duplicate) gets false and skips.
 */
export async function claimOutboundOnce(params: {
  readonly organizationId: string;
  readonly customerId: string;
  readonly triggerType: CommTrigger;
  readonly periodKey: string;
}): Promise<boolean> {
  const claimed = await db
    .insert(outboundMessageLedger)
    .values({
      organizationId: params.organizationId,
      customerId: params.customerId,
      triggerType: params.triggerType,
      periodKey: params.periodKey,
    })
    .onConflictDoNothing()
    .returning({ id: outboundMessageLedger.id });
  return claimed.length > 0;
}
