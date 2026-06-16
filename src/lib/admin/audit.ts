/**
 * Audit logging helper for admin mutations.
 *
 * Every state-changing admin operation MUST call logAudit to ensure
 * all mutations are traceable (T-03-09 non-repudiation mitigation).
 */
import { db } from "@/lib/db";
import { auditLog } from "@/lib/db/schema";

interface AuditParams {
  readonly organizationId: string;
  readonly userId: string;
  readonly action: string;
  readonly entity: string;
  readonly entityId?: string;
  readonly details?: string;
  readonly ipAddress?: string | null;
  /** human (a logged-in user, default) | ai (autonomous agent) | system. */
  readonly actorType?: "human" | "ai" | "system";
}

export async function logAudit(params: AuditParams): Promise<void> {
  await db.insert(auditLog).values({
    organizationId: params.organizationId,
    userId: params.userId,
    actorType: params.actorType ?? "human",
    action: params.action,
    entity: params.entity,
    entityId: params.entityId ?? null,
    details: params.details ?? null,
    ipAddress: params.ipAddress ?? null,
  });
}
