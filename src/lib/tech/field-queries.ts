/**
 * Technician field workflow — server-side queries for on-site work capture.
 *
 * A technician on-site records the MATERIALS they actually used, posts on-site
 * NOTES, and captures the customer's E-SIGNATURE at sign-off. Every mutation is
 * scoped to the org (withTenant) and guarded by the ownership rule in
 * src/lib/tech/ownership.ts.
 *
 * Money is integer cents. For a catalog material the unit cost/price are
 * SNAPSHOTTED server-side from the pricebook item (client-sent costs are
 * ignored), like the estimate picker; a manual (off-catalog) material defaults
 * its costs to 0.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  attachments,
  jobMaterials,
  requestNotes,
  requestStatusEvents,
  serviceRequests,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import {
  findAllAssignments,
  findReadableJob,
  hasOtherOpenRows,
  OPEN_ASSIGNMENT_STATUSES,
  pickActiveAssignment,
  pickActiveVisit,
  techCanReadSql,
  type TechAssignmentRow,
} from "@/lib/tech/ownership";
import { allowedActions, type Blocker, type TechAction } from "@/lib/tech/status-actions";
import { closeOutBlockers } from "@/lib/tech/status-writes";
import { decrypt } from "@/lib/crypto";
import { getPricebookItemById } from "@/lib/admin/pricebook-queries";
import { adjustStock } from "@/lib/admin/inventory-queries";
import { rollUpActualMaterialsCost } from "@/lib/admin/margin";
import { MAX_PRICE_CENTS } from "@/lib/admin/money-format";

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
  /** The caller's row this summary is about (null for a legacy assigned_to-only reader). */
  readonly assignment: TechAssignmentRow | null;
  readonly allowedActions: readonly TechAction[];
  readonly blockers: readonly Blocker[];
  readonly native: boolean;
  /** When the customer signed on site (database clock), null if unsigned. */
  readonly signedAt: Date | null;
  /** The request's newest native non-void invoice, draft/open preferred. */
  readonly invoiceSummary: TechInvoiceSummary | null;
}

export interface TechInvoiceSummary {
  readonly id: string;
  readonly state: "draft" | "open" | "paid" | "refunded";
  readonly balanceCents: number;
}

/** Newest native (not FieldPulse/HCP-mirrored) non-void invoice on the request,
 * an open draft/open one before a settled one; balance floored at 0. */
async function findInvoiceSummary(
  organizationId: string,
  serviceRequestId: string,
): Promise<TechInvoiceSummary | null> {
  const { rows } = await db.execute(sql`SELECT id, state, GREATEST(0, total_cents - amount_paid_cents) AS balance_cents
    FROM invoices
    WHERE organization_id = ${organizationId}::uuid AND service_request_id = ${serviceRequestId}::uuid
      AND state <> 'void'::invoice_state AND fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL
    ORDER BY (state IN ('draft'::invoice_state, 'open'::invoice_state)) DESC, created_at DESC
    LIMIT 1`);
  const r = rows[0] as { id: string; state: TechInvoiceSummary["state"]; balance_cents: number | string } | undefined;
  return r ? { id: r.id, state: r.state, balanceCents: Number(r.balance_cents) } : null;
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
  appointmentId?: string,
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
      fieldpulseJobId: serviceRequests.fieldpulseJobId,
      hcpJobId: serviceRequests.hcpJobId,
      signedAt: serviceRequests.signedAt,
    })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, serviceRequestId),
          techCanReadSql(organizationId, techUserId),
        )!,
      ),
    )
    .limit(1);

  if (!row) return null;

  const [all, invoiceSummary] = await Promise.all([
    findAllAssignments(organizationId, serviceRequestId),
    findInvoiceSummary(organizationId, serviceRequestId),
  ]);
  const active = pickActiveVisit(all);
  const activeVisitId = active?.appointmentId ?? null;
  const mine = all.filter((r) => r.technicianId === techUserId);
  const assignment = appointmentId
    ? (mine.find((r) => r.appointmentId === appointmentId) ?? null)
    : pickActiveAssignment(mine, activeVisitId);
  // A ?visit= that is not one of the caller's visits on this job is not theirs.
  if (appointmentId && !assignment) return null;

  const native = row.fieldpulseJobId === null && row.hcpJobId === null;
  const actions = assignment
    ? allowedActions({
        row: assignment, requestStatus: row.status, activeVisitId,
        otherOpenRows: hasOtherOpenRows(all, assignment.assignmentId), native,
      })
    : [];
  const blockers: readonly Blocker[] = !native
    ? [{ kind: "managed_externally" }]
    : assignment?.isLead
      ? await closeOutBlockers(organizationId, serviceRequestId, { technicianId: techUserId, appointmentId: assignment.appointmentId })
      : [];

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
    assignment,
    allowedActions: actions,
    blockers,
    native,
    signedAt: row.signedAt,
    invoiceSummary,
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
  return (await findReadableJob(organizationId, techUserId, serviceRequestId))?.id ?? null;
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
  /** Manual lines only: the tech's price per unit. Ignored for catalog lines (snapshotted). */
  readonly unitPriceCents?: number | null;
}

/** A manual price is whole cents, ≥ 0, and the line total stays within the money cap. */
export function validManualPrice(unitPriceCents: number, quantity: number): boolean {
  return (
    Number.isInteger(unitPriceCents) &&
    unitPriceCents >= 0 &&
    unitPriceCents <= MAX_PRICE_CENTS &&
    unitPriceCents * quantity <= MAX_PRICE_CENTS
  );
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
    // Reject a missing OR soft-deleted (inactive) item — an inactive catalog row
    // must not be bookable as a job material even via a direct POST (the tech
    // pricebook picker already hides them).
    // A service is billed on the invoice, never consumed as a material.
    if (!item || !item.active || item.type === "service") {
      return { ok: false, reason: "item_not_found" };
    }
    pricebookItemId = item.id;
    description = input.description?.trim() || item.name;
    unitCostCents = item.costCents;
    unitPriceCents = item.priceCents;
  } else {
    // Manual line: must carry a description; cost stays 0, the price is the
    // tech's (optional, default 0) within the money caps.
    const trimmed = input.description?.trim();
    if (!trimmed) {
      return { ok: false, reason: "invalid_input" };
    }
    const price = input.unitPriceCents ?? 0;
    if (!validManualPrice(price, input.quantity)) {
      return { ok: false, reason: "invalid_input" };
    }
    description = trimmed;
    unitPriceCents = price;
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

// Constants, not user input: inlined with enum casts so the IN list is typed.
export const SIGNABLE_IN = sql.raw(`(${[...OPEN_ASSIGNMENT_STATUSES, "completed"].map((st) => `'${st}'::request_status`).join(", ")})`);

export type RecordSignatureResult =
  | { readonly ok: true; readonly previousUrl: string | null }
  | { readonly ok: false; readonly reason: "not_owned" };

/**
 * Record the on-site customer e-signature on a job: the R2 URL of the stored PNG
 * + the customer's printed name + a signed-at timestamp. Assignee + tenant
 * guarded. NOTE: signatureName is PII — do NOT log it.
 *
 * ONE statement: the FOR UPDATE subquery reads the URL being replaced (returned
 * as previousUrl so the caller can delete the old object), and signed_at comes
 * from the DATABASE clock — finalize compares it with invoices.updated_at =
 * now(), so a JS Date here would skew against it.
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
  // includes the customer's signed name (PII). The lead EXISTS guard makes the
  // UPDATE a no-op in that race; 0 rows → treat as not_owned.
  const { rows } = await db.execute(sql`UPDATE service_requests
    SET signature_url = ${input.signatureUrl}, signature_name = ${input.signatureName}, signed_at = now(), updated_at = now()
    FROM (SELECT id, signature_url AS old FROM service_requests WHERE id = ${serviceRequestId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE) o
    WHERE service_requests.id = o.id AND service_requests.organization_id = ${organizationId}::uuid
      AND EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = service_requests.id AND p.organization_id = ${organizationId}::uuid AND a.organization_id = ${organizationId}::uuid AND a.technician_id = ${techUserId} AND a.is_lead AND a.status IN ${SIGNABLE_IN} AND p.cancelled_at IS NULL)
    RETURNING o.old`);
  const updated = rows[0] as { old: string | null } | undefined;
  if (!updated) {
    return { ok: false, reason: "not_owned" };
  }
  return { ok: true, previousUrl: updated.old ?? null };
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
