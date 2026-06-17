/**
 * Tenant-scoped queries for attachments (job photos, equipment media, customer
 * documents).
 *
 * Every function takes organizationId as its first parameter and filters on it
 * via withTenant — no query may read or mutate an attachment outside the
 * caller's organization. The entity-link columns (serviceRequestId,
 * equipmentId, customerId) are all nullable; an attachment may be linked to any
 * subset of them.
 */
import "server-only";

import { eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  attachments,
  serviceRequests,
  customerEquipment,
  customers,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

/** The entity an attachment can be scoped to. Exactly one is used per call. */
export interface EntityScope {
  readonly serviceRequestId?: string;
  readonly equipmentId?: string;
  readonly customerId?: string;
}

/** A row safe to expose to the admin UI — no storageKey leaks to the client. */
export interface AttachmentSummary {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly serviceRequestId: string | null;
  readonly equipmentId: string | null;
  readonly customerId: string | null;
  readonly createdAt: Date;
}

/**
 * Resolves an EntityScope to a single SQL filter. Exactly one scope key must be
 * provided; returns null when none (or an unknown one) is given so callers can
 * reject the request rather than listing everything.
 */
function scopeCondition(scope: EntityScope) {
  if (scope.serviceRequestId !== undefined) {
    return eq(attachments.serviceRequestId, scope.serviceRequestId);
  }
  if (scope.equipmentId !== undefined) {
    return eq(attachments.equipmentId, scope.equipmentId);
  }
  if (scope.customerId !== undefined) {
    return eq(attachments.customerId, scope.customerId);
  }
  return null;
}

/**
 * Lists attachments linked to a single entity, scoped to the organization.
 * Returns an empty array when no entity scope is provided.
 */
export async function listAttachmentsForEntity(
  organizationId: string,
  scope: EntityScope,
): Promise<AttachmentSummary[]> {
  const condition = scopeCondition(scope);
  if (!condition) {
    return [];
  }

  const rows = await db
    .select({
      id: attachments.id,
      filename: attachments.filename,
      mimeType: attachments.mimeType,
      size: attachments.size,
      serviceRequestId: attachments.serviceRequestId,
      equipmentId: attachments.equipmentId,
      customerId: attachments.customerId,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(withTenant(attachments, organizationId, condition))
    .orderBy(desc(attachments.createdAt));

  return rows;
}

/**
 * Links an existing attachment to an entity (service request, equipment, and/or
 * customer), scoped to the organization. Only the provided keys are updated;
 * omitted keys are left untouched. Returns false when the attachment does not
 * exist in this organization (the update matched no row).
 */
export async function linkAttachmentToEntity(
  organizationId: string,
  attachmentId: string,
  scope: EntityScope,
): Promise<boolean> {
  const updates: Partial<{
    serviceRequestId: string;
    equipmentId: string;
    customerId: string;
  }> = {};
  if (scope.serviceRequestId !== undefined) {
    updates.serviceRequestId = scope.serviceRequestId;
  }
  if (scope.equipmentId !== undefined) {
    updates.equipmentId = scope.equipmentId;
  }
  if (scope.customerId !== undefined) {
    updates.customerId = scope.customerId;
  }

  if (Object.keys(updates).length === 0) {
    return false;
  }

  const updated = await db
    .update(attachments)
    .set(updates)
    .where(
      withTenant(attachments, organizationId, eq(attachments.id, attachmentId)),
    )
    .returning({ id: attachments.id });

  return updated.length > 0;
}

/** The minimal record needed to sign a download URL. */
export interface AttachmentDownloadRecord {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly storageKey: string;
}

/**
 * Fetches an attachment's storage key for signing a download URL, scoped to the
 * organization. Returns null when the attachment does not exist in this
 * organization — this is the ownership check the download route relies on
 * before signing/serving anything.
 */
export async function getAttachmentForDownload(
  organizationId: string,
  attachmentId: string,
): Promise<AttachmentDownloadRecord | null> {
  const [row] = await db
    .select({
      id: attachments.id,
      filename: attachments.filename,
      mimeType: attachments.mimeType,
      storageKey: attachments.storageKey,
    })
    .from(attachments)
    .where(
      withTenant(attachments, organizationId, eq(attachments.id, attachmentId)),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Verifies that the entity an attachment would be linked to actually belongs to
 * this organization. The attachments FKs only guarantee the target row exists —
 * not that it's the caller's tenant — so we must check org ownership before
 * linking to prevent attaching media to another org's records.
 *
 * Exactly one scope key is expected; returns false when none is provided.
 */
export async function entityBelongsToOrg(
  organizationId: string,
  scope: EntityScope,
): Promise<boolean> {
  if (scope.serviceRequestId !== undefined) {
    const [row] = await db
      .select({ id: serviceRequests.id })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.id, scope.serviceRequestId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
  if (scope.equipmentId !== undefined) {
    const [row] = await db
      .select({ id: customerEquipment.id })
      .from(customerEquipment)
      .where(
        withTenant(
          customerEquipment,
          organizationId,
          eq(customerEquipment.id, scope.equipmentId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
  if (scope.customerId !== undefined) {
    const [row] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(
        withTenant(
          customers,
          organizationId,
          eq(customers.id, scope.customerId),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
  return false;
}
