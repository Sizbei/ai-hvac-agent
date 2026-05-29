import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions, auditLog } from "@/lib/db/schema";
import { transition, type SessionState } from "@/lib/ai/state-machine";
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

  const result = transition(currentStatus, "escalated");
  if (!result.success) {
    return { ok: false, reason: result.reason };
  }

  await db
    .update(customerSessions)
    .set({ status: "escalated", updatedAt: new Date() })
    .where(eq(customerSessions.id, sessionId));

  await db.insert(auditLog).values({
    organizationId,
    sessionId,
    action: "session_escalated",
    entity: "customer_sessions",
    entityId: sessionId,
    ipAddress,
  });

  logger.info({ sessionId }, "Session escalated to human");

  return { ok: true };
}
