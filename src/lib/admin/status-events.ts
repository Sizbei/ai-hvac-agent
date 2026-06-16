/**
 * Append-only service-request status eventing.
 *
 * Every status transition should record a row here so downstream stages have a
 * real history: on-time KPIs, labor-hours / payroll (Stage 10), and
 * tech-on-the-way automation (Stage 6). actorType distinguishes a human
 * dispatcher from the AI agent or a system/webhook. No PII — ids + enums only.
 */
import { db } from "@/lib/db";
import { requestStatusEvents } from "@/lib/db/schema";
import type { RequestStatus } from "./request-status";

export type ActorType = "human" | "ai" | "system";

/**
 * Record one status transition. Best-effort and decoupled from the guarded
 * status UPDATE: the caller writes the status first and only logs the event once
 * the update is confirmed, so a missing event can never imply a status change
 * that didn't happen.
 */
export async function recordStatusEvent(params: {
  readonly organizationId: string;
  readonly serviceRequestId: string;
  readonly fromStatus: RequestStatus | null;
  readonly toStatus: RequestStatus;
  readonly actorType: ActorType;
  readonly actorId?: string | null;
}): Promise<void> {
  await db.insert(requestStatusEvents).values({
    organizationId: params.organizationId,
    serviceRequestId: params.serviceRequestId,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    actorType: params.actorType,
    actorId: params.actorId ?? null,
  });
}
