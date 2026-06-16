/**
 * Stage 6 — AI online-booking recovery.
 *
 * Finds abandoned SMS conversations that have a known customer + phone and sends
 * ONE consent-gated, ledger-deduped recovery text that reopens the thread (a
 * reply re-enters the same sms/incoming brain). This is ServiceTitan's
 * "Scheduling Pro" abandoned-booking recovery — for us it's a cron over infra we
 * already own (consent gate + outbound ledger + the existing chat brain).
 *
 * Conservative by design: only sessions abandoned within a recent window, only
 * with a resolved customerId (so consent + dedupe both apply), exactly one nudge
 * per session (the ledger periodKey is the session id).
 */
import { and, eq, gte, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions } from "@/lib/db/schema";
import { claimOutboundOnce } from "./outbound-ledger";
import { checkSendAllowed } from "./consent";
import { sendSms } from "./twilio-adapter";
import { logger } from "@/lib/logger";

const RECOVERY_MESSAGE =
  "Hi! It looks like we didn't finish setting up your HVAC service request. Reply here and I can pick up right where we left off.";

/** Don't nudge instantly (let them come back on their own) and don't chase old
 *  threads. Recover sessions abandoned between 30 min and 24 h ago. */
const MIN_AGE_MS = 30 * 60 * 1000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface RecoveryResult {
  readonly considered: number;
  readonly sent: number;
  readonly skipped: number;
}

/**
 * Run one recovery pass for an org. Idempotent: re-running sends nothing new
 * (the outbound ledger claims each session once). Best-effort per session — a
 * single send failure doesn't abort the batch.
 */
export async function recoverAbandonedBookings(
  organizationId: string,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<RecoveryResult> {
  void fetchImpl;
  const newest = new Date(now.getTime() - MIN_AGE_MS);
  const oldest = new Date(now.getTime() - MAX_AGE_MS);

  const candidates = await db
    .select({
      id: customerSessions.id,
      token: customerSessions.token,
      customerId: customerSessions.customerId,
    })
    .from(customerSessions)
    .where(
      and(
        eq(customerSessions.organizationId, organizationId),
        eq(customerSessions.status, "abandoned"),
        eq(customerSessions.channel, "sms"),
        lt(customerSessions.updatedAt, newest),
        gte(customerSessions.updatedAt, oldest),
      ),
    );

  let sent = 0;
  let skipped = 0;
  for (const c of candidates) {
    // Need a known customer (consent + dedupe both key on it) and a phone.
    if (!c.customerId || !c.token.startsWith("sms:")) {
      skipped++;
      continue;
    }
    const phone = c.token.slice("sms:".length);

    // Claim FIRST so a cron retry can't double-send, even if the send throws.
    const claimed = await claimOutboundOnce({
      organizationId,
      customerId: c.customerId,
      triggerType: "follow_up",
      periodKey: `recovery:${c.id}`,
    });
    if (!claimed) {
      skipped++;
      continue;
    }

    const decision = await checkSendAllowed({
      organizationId,
      customerId: c.customerId,
      channel: "sms",
      triggerType: "follow_up",
      now,
    });
    if (!decision.allowed) {
      skipped++;
      continue;
    }

    try {
      await sendSms({ to: phone, body: RECOVERY_MESSAGE });
      sent++;
    } catch (error) {
      logger.error({ error, sessionId: c.id }, "Booking-recovery SMS failed");
      skipped++;
    }
  }

  logger.info(
    { organizationId, considered: candidates.length, sent, skipped },
    "Booking recovery pass complete",
  );
  return { considered: candidates.length, sent, skipped };
}
