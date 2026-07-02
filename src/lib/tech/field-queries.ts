/**
 * Technician field workflow — server-side queries for on-site work capture.
 *
 * A technician on-site records the MATERIALS they actually used, posts on-site
 * NOTES, and captures the customer's E-SIGNATURE at sign-off. Every mutation is
 * scoped to BOTH the assigned tech (assignedTo == techUserId) AND the org
 * (withTenant) — a tech may only touch their OWN job. The assignee+tenant guard
 * mirrors src/app/api/tech/jobs/[id]/status/route.ts exactly.
 *
 * Money is integer cents. For a catalog material the unit cost/price are
 * SNAPSHOTTED server-side from the pricebook item (client-sent costs are
 * ignored), like the estimate picker; a manual (off-catalog) material defaults
 * its costs to 0.
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  attachments,
  jobMaterials,
  requestNotes,
  requestStatusEvents,
  serviceRequests,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import {
  allowedTransitions,
  MANUAL_TARGET_STATUSES,
  type RequestStatus,
} from "@/lib/admin/request-status";
import { getPricebookItemById } from "@/lib/admin/pricebook-queries";
import { adjustStock } from "@/lib/admin/inventory-queries";
import { rollUpActualMaterialsCost } from "@/lib/admin/margin";

/** Decrypt PII, tolerating a value encrypted under a now-rotated key (returns
 * null rather than throwing, so one bad field can't 500 the whole summary). */
function safeDecrypt(value: string | null): string | null {
  if (!value) return null;
  try {
    return decrypt(value);
  } catch {
    return null;
  }
}

/** Everything a tech needs on-site for ONE job they own (assignee+tenant). PII
 * (name/phone/address) decrypted server-side; never log this object. */
export interface TechJobSummary {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: string;
  readonly issueType: string;
  readonly systemType: string | null;
  readonly urgency: string;
  readonly description: string | null;
  readonly scheduledDate: string | null;
  readonly arrivalWindowStart: string | null;
  readonly arrivalWindowEnd: string | null;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly address: string | null;
  readonly accessNotes: string | null;
  /** Manual next-statuses the tech may advance to (FSM ∩ manual targets). */
  readonly allowedNextStatuses: readonly string[];
}

/**
 * Full job summary for the tech's OWN job — the where/what/who they need on-site,
 * with name/phone/address decrypted, plus the manual next-statuses they can move
 * to. Assignee + tenant guarded (same predicate as findOwnedJob), so it returns
 * null when the job doesn't exist in this org or isn't assigned to this tech.
 */
export async function getTechJobSummary(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
): Promise<TechJobSummary | null> {
  const [row] = await db
    .select({
      id: serviceRequests.id,
      referenceNumber: serviceRequests.referenceNumber,
      status: serviceRequests.status,
      issueType: serviceRequests.issueType,
      systemType: serviceRequests.systemType,
      urgency: serviceRequests.urgency,
      description: serviceRequests.description,
      scheduledDate: serviceRequests.scheduledDate,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
      customerNameEncrypted: serviceRequests.customerNameEncrypted,
      customerPhoneEncrypted: serviceRequests.customerPhoneEncrypted,
      addressEncrypted: serviceRequests.addressEncrypted,
      accessNotes: serviceRequests.accessNotes,
    })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, serviceRequestId),
          eq(serviceRequests.assignedTo, techUserId),
        )!,
      ),
    )
    .limit(1);

  if (!row) return null;

  const manual = MANUAL_TARGET_STATUSES as readonly RequestStatus[];
  const allowedNextStatuses = allowedTransitions(
    row.status as RequestStatus,
  ).filter((s) => manual.includes(s));

  return {
    id: row.id,
    referenceNumber: row.referenceNumber,
    status: row.status,
    issueType: row.issueType,
    systemType: row.systemType,
    urgency: row.urgency,
    description: row.description,
    scheduledDate: row.scheduledDate?.toISOString() ?? null,
    arrivalWindowStart: row.arrivalWindowStart?.toISOString() ?? null,
    arrivalWindowEnd: row.arrivalWindowEnd?.toISOString() ?? null,
    customerName: safeDecrypt(row.customerNameEncrypted),
    customerPhone: safeDecrypt(row.customerPhoneEncrypted),
    address: safeDecrypt(row.addressEncrypted),
    accessNotes: row.accessNotes,
    allowedNextStatuses,
  };
}

/**
 * Assignee + tenant guard: returns the job id only if it exists in this org AND
 * is assigned to this tech. Reused by every field mutation. Mirrors the guard in
 * the status route (org-scoped + assignee-scoped).
 */
/** True when the job is assigned to this tech in this org — the read-side
 * ownership gate for tech GET routes that would otherwise expose any org job's
 * data (timesheet/materials/photos) to any technician. */
export async function isJobOwnedByTech(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
): Promise<boolean> {
  return (
    (await findOwnedJob(organizationId, techUserId, serviceRequestId)) !== null
  );
}

async function findOwnedJob(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
): Promise<string | null> {
  const [owned] = await db
    .select({ id: serviceRequests.id })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, serviceRequestId),
          eq(serviceRequests.assignedTo, techUserId),
        )!,
      ),
    )
    .limit(1);
  return owned?.id ?? null;
}

export interface JobMaterialRow {
  readonly id: string;
  readonly pricebookItemId: string | null;
  readonly description: string | null;
  readonly quantity: number;
  readonly unitCostCents: number;
  readonly unitPriceCents: number;
  readonly createdAt: Date;
}

export type AddJobMaterialResult =
  | { readonly ok: true; readonly id: string }
  | {
      readonly ok: false;
      readonly reason: "not_owned" | "item_not_found" | "invalid_input";
    };

export interface AddJobMaterialInput {
  readonly pricebookItemId?: string | null;
  readonly description?: string | null;
  readonly quantity: number;
}

/**
 * Record a material the tech used on a job. If pricebookItemId is given, the unit
 * cost/price are SNAPSHOTTED from the pricebook item (server-authoritative — any
 * client-sent costs are ignored). Otherwise it's a manual line: costs default to
 * 0 and a description is required. Assignee + tenant guarded.
 */
export async function addJobMaterial(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
  input: AddJobMaterialInput,
): Promise<AddJobMaterialResult> {
  if (!Number.isInteger(input.quantity) || input.quantity < 1) {
    return { ok: false, reason: "invalid_input" };
  }

  const owned = await findOwnedJob(organizationId, techUserId, serviceRequestId);
  if (!owned) {
    return { ok: false, reason: "not_owned" };
  }

  let pricebookItemId: string | null = null;
  let description: string | null = null;
  let unitCostCents = 0;
  let unitPriceCents = 0;

  if (input.pricebookItemId) {
    // Catalog line: snapshot cost/price from the org's pricebook item. Costs the
    // client sent are NOT trusted — the server is authoritative.
    const item = await getPricebookItemById(organizationId, input.pricebookItemId);
    if (!item) {
      return { ok: false, reason: "item_not_found" };
    }
    pricebookItemId = item.id;
    description = input.description?.trim() || item.name;
    unitCostCents = item.costCents;
    unitPriceCents = item.priceCents;
  } else {
    // Manual line: must carry a description; costs default to 0.
    const trimmed = input.description?.trim();
    if (!trimmed) {
      return { ok: false, reason: "invalid_input" };
    }
    description = trimmed;
  }

  const [created] = await db
    .insert(jobMaterials)
    .values({
      organizationId,
      serviceRequestId,
      pricebookItemId,
      description,
      quantity: input.quantity,
      unitCostCents,
      unitPriceCents,
      createdBy: techUserId,
    })
    .returning({ id: jobMaterials.id });

  if (!created) {
    throw new Error("Failed to record job material");
  }

  // Best-effort stock decrement: when this is a catalog material tracked in the
  // org's inventory, consuming it on a job draws down on-hand stock (clamped at
  // 0 in SQL). adjustStock is a no-op for untracked items, so manual lines and
  // non-inventory catalog items are unaffected. A failure here must NOT fail the
  // recorded usage — the job material is already persisted.
  if (pricebookItemId) {
    await adjustStock(organizationId, pricebookItemId, -input.quantity).catch(
      () => {
        // Inventory is a soft side effect of usage; swallow so the contract of
        // addJobMaterial (record the material) is preserved.
      },
    );
  }

  return { ok: true, id: created.id };
}

export type RemoveJobMaterialResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_owned" };

/**
 * Remove a material the tech added. Guard: the material must belong to the org
 * AND sit on a job assigned to this tech. We resolve the material's job first,
 * then re-run the assignee guard so a tech can't delete another tech's lines.
 */
export async function removeJobMaterial(
  organizationId: string,
  techUserId: string,
  materialId: string,
): Promise<RemoveJobMaterialResult> {
  const [material] = await db
    .select({ serviceRequestId: jobMaterials.serviceRequestId })
    .from(jobMaterials)
    .where(
      withTenant(jobMaterials, organizationId, eq(jobMaterials.id, materialId)),
    )
    .limit(1);
  if (!material) {
    return { ok: false, reason: "not_owned" };
  }

  const owned = await findOwnedJob(
    organizationId,
    techUserId,
    material.serviceRequestId,
  );
  if (!owned) {
    return { ok: false, reason: "not_owned" };
  }

  await db
    .delete(jobMaterials)
    .where(
      withTenant(jobMaterials, organizationId, eq(jobMaterials.id, materialId)),
    );
  return { ok: true };
}

/** List the materials recorded on a job (org-scoped). */
export async function listJobMaterials(
  organizationId: string,
  serviceRequestId: string,
): Promise<readonly JobMaterialRow[]> {
  return db
    .select({
      id: jobMaterials.id,
      pricebookItemId: jobMaterials.pricebookItemId,
      description: jobMaterials.description,
      quantity: jobMaterials.quantity,
      unitCostCents: jobMaterials.unitCostCents,
      unitPriceCents: jobMaterials.unitPriceCents,
      createdAt: jobMaterials.createdAt,
    })
    .from(jobMaterials)
    .where(
      withTenant(
        jobMaterials,
        organizationId,
        eq(jobMaterials.serviceRequestId, serviceRequestId),
      ),
    )
    .orderBy(asc(jobMaterials.createdAt));
}

/**
 * Total ACTUAL materials cost for a job (sum of unitCost × qty). Feeds the
 * admin invoice's actual-vs-estimated margin readout. Reuses the pure rollup.
 */
export async function getActualMaterialsCostCents(
  organizationId: string,
  serviceRequestId: string,
): Promise<number> {
  const rows = await listJobMaterials(organizationId, serviceRequestId);
  return rollUpActualMaterialsCost(rows);
}

export type RecordSignatureResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_owned" };

/**
 * Record the on-site customer e-signature on a job: the R2 URL of the stored PNG
 * + the customer's printed name + a signed-at timestamp. Assignee + tenant
 * guarded. NOTE: signatureName is PII — do NOT log it.
 */
export async function recordSignature(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
  input: { readonly signatureUrl: string; readonly signatureName: string },
): Promise<RecordSignatureResult> {
  const owned = await findOwnedJob(organizationId, techUserId, serviceRequestId);
  if (!owned) {
    return { ok: false, reason: "not_owned" };
  }

  // Re-assert ownership IN the write (not just the read above): a job reassigned
  // between findOwnedJob and here must not receive this tech's signature — which
  // includes the customer's signed name (PII). The assignee guard makes the
  // UPDATE a no-op in that race; 0 rows → treat as not_owned.
  const [updated] = await db
    .update(serviceRequests)
    .set({
      signatureUrl: input.signatureUrl,
      signatureName: input.signatureName,
      signedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, serviceRequestId),
          eq(serviceRequests.assignedTo, techUserId),
        )!,
      ),
    )
    .returning({ id: serviceRequests.id });
  if (!updated) {
    return { ok: false, reason: "not_owned" };
  }
  return { ok: true };
}

export type AddFieldNoteResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: "not_owned" | "invalid_input" };

/**
 * Post an on-site note from the field. Reuses the request_notes mechanism (the
 * tech is the author). Assignee + tenant guarded.
 */
export async function addFieldNote(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
  content: string,
): Promise<AddFieldNoteResult> {
  const trimmed = content.trim();
  if (!trimmed) {
    return { ok: false, reason: "invalid_input" };
  }

  const owned = await findOwnedJob(organizationId, techUserId, serviceRequestId);
  if (!owned) {
    return { ok: false, reason: "not_owned" };
  }

  const [created] = await db
    .insert(requestNotes)
    .values({
      requestId: serviceRequestId,
      organizationId,
      authorId: techUserId,
      content: trimmed,
    })
    .returning({ id: requestNotes.id });

  if (!created) {
    throw new Error("Failed to record field note");
  }
  return { ok: true, id: created.id };
}

/** A single status transition in a job's timeline. PII-free: statuses + actor
 *  KIND + timestamp only (no actorId/name). */
export interface JobTimelineEntry {
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly actorType: string;
  readonly at: string; // ISO-8601
}

export type JobTimelineResult =
  | { readonly ok: true; readonly timeline: readonly JobTimelineEntry[] }
  | { readonly ok: false; readonly reason: "not_owned" };

/**
 * The status-transition timeline for a job the tech owns (read-only). Reuses the
 * append-only request_status_events log (already written on every transition).
 * Assignee + tenant guarded like every other field query; PII-free (no actorId).
 */
export async function getJobTimelineForTech(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
): Promise<JobTimelineResult> {
  const owned = await findOwnedJob(organizationId, techUserId, serviceRequestId);
  if (!owned) {
    return { ok: false, reason: "not_owned" };
  }

  const rows = await db
    .select({
      fromStatus: requestStatusEvents.fromStatus,
      toStatus: requestStatusEvents.toStatus,
      actorType: requestStatusEvents.actorType,
      at: requestStatusEvents.at,
    })
    .from(requestStatusEvents)
    .where(
      withTenant(
        requestStatusEvents,
        organizationId,
        eq(requestStatusEvents.serviceRequestId, serviceRequestId),
      ),
    )
    .orderBy(asc(requestStatusEvents.at));

  return {
    ok: true,
    timeline: rows.map((r) => ({
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      actorType: r.actorType,
      at: r.at.toISOString(),
    })),
  };
}

export interface JobPhotoInput {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly storageKey: string;
}

export type AddJobPhotoResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: "not_owned" };

/**
 * Record a job photo the tech uploaded. The file itself lives in R2 (uploaded by
 * the route); this stores the metadata in the shared `attachments` table linked
 * to the service request (the Stage-7 serviceRequestId link). Assignee + tenant
 * guarded — a tech may only attach to their OWN job.
 */
export async function addJobPhoto(
  organizationId: string,
  techUserId: string,
  serviceRequestId: string,
  input: JobPhotoInput,
): Promise<AddJobPhotoResult> {
  const owned = await findOwnedJob(organizationId, techUserId, serviceRequestId);
  if (!owned) {
    return { ok: false, reason: "not_owned" };
  }

  const [created] = await db
    .insert(attachments)
    .values({
      organizationId,
      serviceRequestId,
      filename: input.filename,
      mimeType: input.mimeType,
      size: input.size,
      storageKey: input.storageKey,
    })
    .returning({ id: attachments.id });

  if (!created) {
    throw new Error("Failed to record job photo");
  }
  return { ok: true, id: created.id };
}

export interface JobPhotoRow {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly storageKey: string;
  readonly createdAt: Date;
}

/** List the attachments linked to a job (org-scoped), oldest first. */
export async function listJobPhotos(
  organizationId: string,
  serviceRequestId: string,
): Promise<readonly JobPhotoRow[]> {
  return db
    .select({
      id: attachments.id,
      filename: attachments.filename,
      mimeType: attachments.mimeType,
      size: attachments.size,
      storageKey: attachments.storageKey,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(
      withTenant(
        attachments,
        organizationId,
        eq(attachments.serviceRequestId, serviceRequestId),
      ),
    )
    .orderBy(asc(attachments.createdAt));
}
