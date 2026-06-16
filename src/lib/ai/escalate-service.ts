import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions, auditLog } from "@/lib/db/schema";
import { transition, type SessionState } from "@/lib/ai/state-machine";
import { summarizeAndClassifySession } from "@/lib/ai/session-outcome";
import { logger } from "@/lib/logger";

export interface EscalateResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Escalates a customer session to a human agent.
 *
 * Shared by the explicit `/api/session/escalate` route and the deterministic
 * intent router's ESCALATE branch so both paths enforce the state-machine guard
 * AND write the audit-log entry. The audit trail is safety-critical for
 * emergency intents (gas/CO/fire), where there must be a record that the system
 * told a customer to evacuate.
 */
export async function escalateSession(params: {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly currentStatus: SessionState;
  readonly ipAddress: string;
}): Promise<EscalateResult> {
  const { organizationId, sessionId, currentStatus, ipAddress } = params;

  // Already escalated → idempotent success with NO new write/audit. This MUST
  // come before the status-guarded UPDATE below: an UPDATE WHERE status =
  // 'escalated' would still match the live (already-escalated) row and write a
  // duplicate audit entry.
  if (currentStatus === "escalated") {
    return { ok: true };
  }

  const result = transition(currentStatus, "escalated");
  if (!result.success) {
    return { ok: false, reason: result.reason };
  }

  // Guard the UPDATE by the EXPECTED current status too, so two concurrent
  // escalations don't both "succeed": the first transitions the row, the second
  // matches zero rows (status already moved) and we skip the duplicate audit
  // entry. Closes the TOCTOU between the in-memory transition() check above and
  // the write.
  const [updated] = await db
    .update(customerSessions)
    .set({ status: "escalated", updatedAt: new Date() })
    .where(
      and(
        eq(customerSessions.id, sessionId),
        eq(customerSessions.organizationId, organizationId),
        eq(customerSessions.status, currentStatus),
      ),
    )
    .returning({ id: customerSessions.id });

  if (!updated) {
    // A concurrent request already moved the session on (status no longer
    // matches). Benign race — the escalation already happened. Report it so the
    // caller doesn't log a phantom failure.
    return { ok: false, reason: "already_transitioned" };
  }

  await db.insert(auditLog).values({
    organizationId,
    sessionId,
    action: "session_escalated",
    entity: "customer_sessions",
    entityId: sessionId,
    ipAddress,
  });

  logger.info({ sessionId }, "Session escalated to human");

  // Stage 3: AI summary + outcome for the escalated conversation (background).
  after(() =>
    summarizeAndClassifySession({
      organizationId,
      sessionId,
      definiteOutcome: "escalated",
    }),
  );

  return { ok: true };
}
