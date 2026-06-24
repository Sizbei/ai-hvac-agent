/**
 * Database query functions for admin operations.
 *
 * Every query function takes organizationId as its first parameter
 * and uses withTenant to enforce multi-tenancy (key_links contract).
 */
import {
  eq,
  and,
  count,
  desc,
  asc,
  gt,
  gte,
  lt,
  inArray,
  ilike,
  isNull,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  serviceRequests,
  requestNotes,
  users,
  messages,
  requestStatusEnum,
  holdReasonEnum,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { normalizeEmail } from "./staff-queries";
import { decrypt } from "@/lib/crypto";
import {
  canTransition,
  type RequestStatus,
} from "./request-status";
import { recordStatusEvent, type ActorType } from "./status-events";

export type HoldReason = (typeof holdReasonEnum.enumValues)[number];
import { DASHBOARD_LIST_LIMIT } from "./types";
import { getTechnicianAvailability } from "./scheduling-queries";
import { businessIsoDate } from "./calendar-time";
import type {
  AdminRequest,
  AdminRequestDetail,
  TechnicianRecord,
  DashboardStats,
  DashboardRequest,
  DashboardOverview,
  DispatchBoard,
  DispatchColumn,
  SchedulingCalendar,
  CalendarTechnicianLane,
  MonthCalendar,
  MonthCalendarDay,
  RequestFilters,
  CreateTechnicianInput,
  UpdateTechnicianInput,
  TranscriptMessage,
  RequestNote,
} from "./types";
import { hash } from "bcryptjs";

function safeDecrypt(ciphertext: string | null): string | null {
  if (!ciphertext) {
    return null;
  }
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}

function startOfTodayUTC(): Date {
  return new Date(
    new Date().toISOString().split("T")[0] + "T00:00:00.000Z",
  );
}

/** UTC [start, end) day bounds for an ISO date string (YYYY-MM-DD). Returns
 * null for anything that isn't a valid calendar date so callers fail closed
 * rather than querying a garbage range. */
function utcDayBounds(
  isoDate: string,
): { readonly start: Date; readonly end: Date; readonly date: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const start = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return null;
  // Reject overflow dates (e.g. 2026-02-30 → March) by round-tripping.
  if (start.toISOString().slice(0, 10) !== isoDate) return null;
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, date: isoDate };
}

/** The ISO date (YYYY-MM-DD) of the current UTC day. */
function todayUTCDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getRequests(
  organizationId: string,
  filters: RequestFilters,
): Promise<{ readonly requests: readonly AdminRequest[]; readonly total: number }> {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const offset = (page - 1) * limit;

  type RequestStatus = (typeof requestStatusEnum.enumValues)[number];
  const validStatuses: readonly string[] = requestStatusEnum.enumValues;

  // Build the optional filters, then hand them to withTenant as variadic
  // conditions (each is ANDed with the org scope).
  const extraConditions: SQL[] = [];
  if (filters.status && validStatuses.includes(filters.status)) {
    extraConditions.push(
      eq(serviceRequests.status, filters.status as RequestStatus),
    );
  }
  const search = filters.search?.trim();
  if (search) {
    // Reference number is plaintext + indexed. Prefix match (ilike 'X%') so the
    // requests_ref_idx can serve it; escape LIKE metacharacters in user input.
    const escaped = search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    extraConditions.push(
      ilike(serviceRequests.referenceNumber, `${escaped}%`),
    );
  }

  const baseConditions = withTenant(
    serviceRequests,
    organizationId,
    ...extraConditions,
  );

  // Count total matching records
  const [countResult] = await db
    .select({ value: count() })
    .from(serviceRequests)
    .where(baseConditions);

  const total = countResult?.value ?? 0;

  // Fetch paginated results with assigned technician name
  const rows = await db
    .select({
      id: serviceRequests.id,
      status: serviceRequests.status,
      issueType: serviceRequests.issueType,
      urgency: serviceRequests.urgency,
      description: serviceRequests.description,
      referenceNumber: serviceRequests.referenceNumber,
      customerNameEncrypted: serviceRequests.customerNameEncrypted,
      assignedToName: users.name,
      isAfterHours: serviceRequests.isAfterHours,
      createdAt: serviceRequests.createdAt,
      updatedAt: serviceRequests.updatedAt,
    })
    .from(serviceRequests)
    .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
    .where(baseConditions)
    .orderBy(desc(serviceRequests.createdAt))
    .limit(limit)
    .offset(offset);

  const requests: readonly AdminRequest[] = rows.map((row) => ({
    id: row.id,
    status: row.status,
    issueType: row.issueType,
    urgency: row.urgency,
    description: row.description,
    referenceNumber: row.referenceNumber,
    customerName: safeDecrypt(row.customerNameEncrypted),
    assignedToName: row.assignedToName,
    isAfterHours: row.isAfterHours,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));

  return { requests, total };
}

export async function getRequestById(
  organizationId: string,
  requestId: string,
): Promise<AdminRequestDetail | null> {
  const [row] = await db
    .select({
      id: serviceRequests.id,
      status: serviceRequests.status,
      issueType: serviceRequests.issueType,
      urgency: serviceRequests.urgency,
      description: serviceRequests.description,
      referenceNumber: serviceRequests.referenceNumber,
      customerNameEncrypted: serviceRequests.customerNameEncrypted,
      customerPhoneEncrypted: serviceRequests.customerPhoneEncrypted,
      customerEmailEncrypted: serviceRequests.customerEmailEncrypted,
      addressEncrypted: serviceRequests.addressEncrypted,
      assignedTo: serviceRequests.assignedTo,
      assignedToName: users.name,
      scheduledDate: serviceRequests.scheduledDate,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
      holdReason: serviceRequests.holdReason,
      followUpDate: serviceRequests.followUpDate,
      isAfterHours: serviceRequests.isAfterHours,
      // Invoice/payment status synced from HCP invoice.* webhooks.
      invoiceStatus: serviceRequests.invoiceStatus,
      completedAt: serviceRequests.completedAt,
      createdAt: serviceRequests.createdAt,
      updatedAt: serviceRequests.updatedAt,
      sessionId: serviceRequests.sessionId,
      // ServiceTitan-style intake details.
      jobType: serviceRequests.jobType,
      systemType: serviceRequests.systemType,
      equipmentBrand: serviceRequests.equipmentBrand,
      equipmentAgeBand: serviceRequests.equipmentAgeBand,
      propertyType: serviceRequests.propertyType,
      ownerOccupant: serviceRequests.ownerOccupant,
      underWarranty: serviceRequests.underWarranty,
      accessNotes: serviceRequests.accessNotes,
      systemDownStatus: serviceRequests.systemDownStatus,
      problemDuration: serviceRequests.problemDuration,
      vulnerableOccupants: serviceRequests.vulnerableOccupants,
      preferredWindow: serviceRequests.preferredWindow,
      contactPreference: serviceRequests.contactPreference,
      smsConsent: serviceRequests.smsConsent,
      leadSource: serviceRequests.leadSource,
    })
    .from(serviceRequests)
    .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.id, requestId),
      ),
    );

  if (!row) {
    return null;
  }

  // Fetch conversation transcript for this session
  const messageRows = await db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      withTenant(
        messages,
        organizationId,
        eq(messages.sessionId, row.sessionId),
      ),
    )
    .orderBy(asc(messages.createdAt));

  const transcript: readonly TranscriptMessage[] = messageRows.map((m) => ({
    role: m.role,
    content: m.content,
    createdAt: m.createdAt.toISOString(),
  }));

  // Internal staff notes (newest first), with the author's display name.
  const noteRows = await db
    .select({
      id: requestNotes.id,
      content: requestNotes.content,
      createdAt: requestNotes.createdAt,
      authorName: users.name,
    })
    .from(requestNotes)
    .leftJoin(users, eq(requestNotes.authorId, users.id))
    .where(
      withTenant(
        requestNotes,
        organizationId,
        eq(requestNotes.requestId, requestId),
      ),
    )
    .orderBy(desc(requestNotes.createdAt));

  const notes: readonly RequestNote[] = noteRows.map((n) => ({
    id: n.id,
    content: n.content,
    authorName: n.authorName,
    createdAt: n.createdAt.toISOString(),
  }));

  return {
    id: row.id,
    status: row.status,
    issueType: row.issueType,
    urgency: row.urgency,
    description: row.description,
    referenceNumber: row.referenceNumber,
    customerName: safeDecrypt(row.customerNameEncrypted),
    customerPhone: safeDecrypt(row.customerPhoneEncrypted),
    customerEmail: safeDecrypt(row.customerEmailEncrypted),
    address: safeDecrypt(row.addressEncrypted),
    assignedTo: row.assignedTo,
    assignedToName: row.assignedToName,
    scheduledDate: row.scheduledDate?.toISOString() ?? null,
    arrivalWindowStart: row.arrivalWindowStart?.toISOString() ?? null,
    arrivalWindowEnd: row.arrivalWindowEnd?.toISOString() ?? null,
    holdReason: row.holdReason,
    followUpDate: row.followUpDate?.toISOString() ?? null,
    isAfterHours: row.isAfterHours,
    invoiceStatus: row.invoiceStatus,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    transcript,
    notes,
    intake: {
      jobType: row.jobType,
      systemType: row.systemType,
      equipmentBrand: row.equipmentBrand,
      equipmentAgeBand: row.equipmentAgeBand,
      propertyType: row.propertyType,
      ownerOccupant: row.ownerOccupant,
      underWarranty: row.underWarranty,
      accessNotes: row.accessNotes,
      systemDownStatus: row.systemDownStatus,
      problemDuration: row.problemDuration,
      vulnerableOccupants: row.vulnerableOccupants,
      preferredWindow: row.preferredWindow,
      contactPreference: row.contactPreference,
      smsConsent: row.smsConsent,
      leadSource: row.leadSource,
    },
  };
}

/** Request statuses from which an initial assignment is allowed. Assigning
 * flips the status to "assigned", so from "in_progress" it would regress and
 * discard progress — that case is handled by reassignTechnician instead, which
 * preserves the status. A "scheduled" request (booked, no tech yet) is the
 * natural assign-from state. Terminal states (completed/cancelled) are never
 * assignable. */
const ASSIGNABLE_STATUSES = ["pending", "scheduled", "assigned"] as const;

/** Non-terminal statuses — a request still needs work. Excludes completed and
 * cancelled. Used by dashboard KPIs (e.g. open emergencies). */
const OPEN_STATUSES = [
  "pending",
  "assigned",
  "scheduled",
  "in_progress",
  "on_hold",
] as const;

/** Statuses a dashboard "needs attention" queue draws from: open and not yet
 * assigned to a tech. */
const UNASSIGNED_OPEN_STATUSES = ["pending", "scheduled"] as const;

/** Statuses from which a REASSIGNMENT (changing the assignee without resetting
 * the lifecycle) is allowed: a request that already has work in flight or
 * paused (on_hold) — reassign without discarding the lifecycle stage. */
const REASSIGNABLE_STATUSES = ["assigned", "in_progress", "on_hold"] as const;

export type AssignTechnicianResult =
  | { readonly ok: true; readonly request: AdminRequest }
  | { readonly ok: false; readonly reason: "technician_not_found" }
  | { readonly ok: false; readonly reason: "request_not_found" }
  | {
      readonly ok: false;
      readonly reason: "request_not_assignable";
      readonly currentStatus: AdminRequest["status"];
    };

export async function assignTechnician(
  organizationId: string,
  requestId: string,
  technicianId: string,
): Promise<AssignTechnicianResult> {
  // Verify the assignee is an ACTIVE TECHNICIAN in this org — not an admin,
  // not a deactivated/off-boarded account, and not a user from another tenant.
  const [tech] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      withTenant(
        users,
        organizationId,
        and(
          eq(users.id, technicianId),
          eq(users.role, "technician"),
          eq(users.isActive, true),
        )!,
      ),
    );

  if (!tech) {
    return { ok: false, reason: "technician_not_found" };
  }

  // Capture the prior status so the status event records the real from-state
  // (pending|scheduled|assigned), not null — needed for accurate dwell-time KPIs.
  const [before] = await db
    .select({ status: serviceRequests.status })
    .from(serviceRequests)
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    );

  const now = new Date();
  // Only flip to "assigned" from an assignable state. Guarding the status in
  // the WHERE clause also closes the lost-update race between two dispatchers:
  // the second UPDATE matches zero rows once the first has moved it on.
  const [updated] = await db
    .update(serviceRequests)
    .set({
      assignedTo: technicianId,
      status: "assigned",
      updatedAt: now,
    })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, requestId),
          inArray(serviceRequests.status, [...ASSIGNABLE_STATUSES]),
        )!,
      ),
    )
    .returning();

  if (!updated) {
    // Either the request doesn't exist (in this org) or it's in a
    // non-assignable state. Reuse the pre-read `before` to disambiguate.
    if (!before) {
      return { ok: false, reason: "request_not_found" };
    }
    return {
      ok: false,
      reason: "request_not_assignable",
      currentStatus: before.status,
    };
  }

  // Record the → assigned transition (fromStatus omitted: the guarded UPDATE
  // doesn't read the prior status on the hot path; toStatus + actor are the
  // salient facts for KPIs).
  await recordStatusEvent({
    organizationId,
    serviceRequestId: requestId,
    fromStatus: before?.status ?? null,
    toStatus: "assigned",
    actorType: "human",
  });

  return {
    ok: true,
    request: {
      id: updated.id,
      status: updated.status,
      issueType: updated.issueType,
      urgency: updated.urgency,
      description: updated.description,
      referenceNumber: updated.referenceNumber,
      customerName: safeDecrypt(updated.customerNameEncrypted),
      assignedToName: tech.name,
      isAfterHours: updated.isAfterHours,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  };
}

export type ReassignTechnicianResult =
  | { readonly ok: true; readonly request: AdminRequest }
  | { readonly ok: false; readonly reason: "technician_not_found" }
  | { readonly ok: false; readonly reason: "request_not_found" }
  | {
      readonly ok: false;
      readonly reason: "request_not_reassignable";
      readonly currentStatus: AdminRequest["status"];
    };

/**
 * Move an in-flight request to a different technician WITHOUT resetting its
 * lifecycle. Unlike assignTechnician (which flips status to "assigned"), this
 * preserves the current status, so reassigning an "in_progress" job keeps it
 * in progress. Allowed only from REASSIGNABLE_STATUSES (assigned/in_progress):
 * a "pending" request has no assignee to swap (use assign), and terminal
 * requests are locked. The status-guarded UPDATE also closes the lost-update
 * race between two dispatchers.
 */
export async function reassignTechnician(
  organizationId: string,
  requestId: string,
  technicianId: string,
): Promise<ReassignTechnicianResult> {
  // Same active-technician-in-this-org check as assignment.
  const [tech] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      withTenant(
        users,
        organizationId,
        and(
          eq(users.id, technicianId),
          eq(users.role, "technician"),
          eq(users.isActive, true),
        )!,
      ),
    );

  if (!tech) {
    return { ok: false, reason: "technician_not_found" };
  }

  // Change the assignee only; status is deliberately left untouched. Guard on
  // the reassignable states so a terminal/pending request matches zero rows.
  const [updated] = await db
    .update(serviceRequests)
    .set({
      assignedTo: technicianId,
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, requestId),
          inArray(serviceRequests.status, [...REASSIGNABLE_STATUSES]),
        )!,
      ),
    )
    .returning();

  if (!updated) {
    const [existing] = await db
      .select({ status: serviceRequests.status })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.id, requestId),
        ),
      );

    if (!existing) {
      return { ok: false, reason: "request_not_found" };
    }
    return {
      ok: false,
      reason: "request_not_reassignable",
      currentStatus: existing.status,
    };
  }

  return {
    ok: true,
    request: {
      id: updated.id,
      status: updated.status,
      issueType: updated.issueType,
      urgency: updated.urgency,
      description: updated.description,
      referenceNumber: updated.referenceNumber,
      customerName: safeDecrypt(updated.customerNameEncrypted),
      assignedToName: tech.name,
      isAfterHours: updated.isAfterHours,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    },
  };
}

export type UpdateRequestStatusResult =
  | { readonly ok: true; readonly status: RequestStatus }
  | { readonly ok: false; readonly reason: "request_not_found" }
  | {
      readonly ok: false;
      readonly reason: "invalid_transition";
      readonly currentStatus: RequestStatus;
    };

/**
 * Manually transitions a request's status (e.g. assigned → in_progress →
 * completed, or cancelled from any open state). Assignment is handled by
 * {@link assignTechnician}; this drives the dispatcher's status controls.
 *
 * The transition is validated two ways: the in-memory state machine
 * ({@link canTransition}) rejects illegal edges with a clear reason, and the
 * UPDATE is guarded on the EXPECTED `from` status so two concurrent dispatchers
 * can't both "succeed" (the second matches zero rows once the first has moved
 * it on). Completing the request stamps `completedAt`; leaving completed (not
 * legal here) would otherwise need to clear it.
 */
export async function updateRequestStatus(
  organizationId: string,
  requestId: string,
  target: RequestStatus,
  holdDetails?: {
    readonly reason: HoldReason | null;
    readonly followUpDate: Date | null;
  },
  // Who drove the transition — recorded on the status event. Defaults to a human
  // dispatcher (this function backs the admin status endpoint).
  actor: { readonly actorType: ActorType; readonly actorId?: string | null } = {
    actorType: "human",
  },
): Promise<UpdateRequestStatusResult> {
  const [existing] = await db
    .select({ status: serviceRequests.status })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.id, requestId),
      ),
    );

  if (!existing) {
    return { ok: false, reason: "request_not_found" };
  }

  if (!canTransition(existing.status, target)) {
    return {
      ok: false,
      reason: "invalid_transition",
      currentStatus: existing.status,
    };
  }

  const now = new Date();
  const [updated] = await db
    .update(serviceRequests)
    .set({
      status: target,
      completedAt: target === "completed" ? now : null,
      // Hold metadata is set when pausing and CLEARED on any other transition
      // (resuming, completing, cancelling) so a stale "waiting on parts" never
      // lingers on a job that's moved on.
      holdReason: target === "on_hold" ? (holdDetails?.reason ?? null) : null,
      followUpDate:
        target === "on_hold" ? (holdDetails?.followUpDate ?? null) : null,
      updatedAt: now,
    })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, requestId),
          eq(serviceRequests.status, existing.status),
        )!,
      ),
    )
    .returning({ status: serviceRequests.status });

  if (!updated) {
    // A concurrent transition moved the row between our read and write.
    return {
      ok: false,
      reason: "invalid_transition",
      currentStatus: existing.status,
    };
  }

  // Record the transition for KPIs / payroll / automation (best-effort: the
  // status write above already committed).
  await recordStatusEvent({
    organizationId,
    serviceRequestId: requestId,
    fromStatus: existing.status,
    toStatus: updated.status,
    actorType: actor.actorType,
    actorId: actor.actorId ?? null,
  });

  return { ok: true, status: updated.status };
}

export type ScheduleRequestResult =
  | {
      readonly ok: true;
      readonly scheduledDate: string | null;
      readonly arrivalWindowStart: string | null;
      readonly arrivalWindowEnd: string | null;
    }
  | { readonly ok: false; readonly reason: "request_not_found" };

/**
 * Sets (or clears, with `null`) a request's scheduled service date and optional
 * ARRIVAL WINDOW (start/end). Org-scoped. Independent of status — a dispatcher
 * can schedule before work starts. Passing `arrivalWindow: null` clears the
 * window; omitting it (undefined) leaves it untouched.
 */
export async function scheduleRequest(
  organizationId: string,
  requestId: string,
  scheduledDate: Date | null,
  arrivalWindow?: { readonly start: Date; readonly end: Date } | null,
): Promise<ScheduleRequestResult> {
  const patch: {
    scheduledDate: Date | null;
    updatedAt: Date;
    arrivalWindowStart?: Date | null;
    arrivalWindowEnd?: Date | null;
  } = { scheduledDate, updatedAt: new Date() };
  if (arrivalWindow !== undefined) {
    patch.arrivalWindowStart = arrivalWindow?.start ?? null;
    patch.arrivalWindowEnd = arrivalWindow?.end ?? null;
  }

  const [updated] = await db
    .update(serviceRequests)
    .set(patch)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.id, requestId),
      ),
    )
    .returning({
      scheduledDate: serviceRequests.scheduledDate,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    });

  if (!updated) {
    return { ok: false, reason: "request_not_found" };
  }

  return {
    ok: true,
    scheduledDate: updated.scheduledDate?.toISOString() ?? null,
    arrivalWindowStart: updated.arrivalWindowStart?.toISOString() ?? null,
    arrivalWindowEnd: updated.arrivalWindowEnd?.toISOString() ?? null,
  };
}

export type AddRequestNoteResult =
  | { readonly ok: true; readonly note: RequestNote }
  | { readonly ok: false; readonly reason: "request_not_found" };

/**
 * Adds an internal staff note to a request. Verifies the request belongs to the
 * org FIRST (so a guessed UUID from another tenant can't have a note attached),
 * then inserts the note carrying the org id and author. Returns the created
 * note (with the author's display name) for optimistic UI insertion.
 */
export async function addRequestNote(
  organizationId: string,
  requestId: string,
  authorId: string,
  content: string,
): Promise<AddRequestNoteResult> {
  const [request] = await db
    .select({ id: serviceRequests.id })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.id, requestId),
      ),
    );

  if (!request) {
    return { ok: false, reason: "request_not_found" };
  }

  const [created] = await db
    .insert(requestNotes)
    .values({ requestId, organizationId, authorId, content })
    .returning({ id: requestNotes.id, createdAt: requestNotes.createdAt });

  if (!created) {
    throw new Error("Failed to create request note");
  }

  // Resolve the author's display name for the returned note. The note's
  // organizationId scopes it; the author is the acting admin.
  const [author] = await db
    .select({ name: users.name })
    .from(users)
    .where(withTenant(users, organizationId, eq(users.id, authorId)));

  return {
    ok: true,
    note: {
      id: created.id,
      content,
      authorName: author?.name ?? null,
      createdAt: created.createdAt.toISOString(),
    },
  };
}

export async function getTechnicians(
  organizationId: string,
): Promise<readonly TechnicianRecord[]> {
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      isActive: users.isActive,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      withTenant(
        users,
        organizationId,
        eq(users.role, "technician"),
      ),
    )
    .orderBy(asc(users.name));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function createTechnician(
  organizationId: string,
  input: CreateTechnicianInput,
): Promise<TechnicianRecord> {
  const passwordHash = await hash(input.password, 12);

  const [created] = await db
    .insert(users)
    .values({
      organizationId,
      name: input.name,
      // Canonicalize email (trim + lowercase) so it matches the per-org
      // uniqueness contract used by the staff surface (staff-queries).
      email: normalizeEmail(input.email),
      passwordHash,
      role: "technician",
      isActive: true,
    })
    .returning();

  if (!created) {
    throw new Error("Failed to create technician");
  }

  return {
    id: created.id,
    name: created.name,
    email: created.email,
    isActive: created.isActive,
    createdAt: created.createdAt.toISOString(),
  };
}

export async function updateTechnician(
  organizationId: string,
  technicianId: string,
  input: UpdateTechnicianInput,
): Promise<TechnicianRecord | null> {
  const updates: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (input.name !== undefined) {
    updates.name = input.name;
  }
  if (input.email !== undefined) {
    updates.email = input.email;
  }
  if (input.isActive !== undefined) {
    updates.isActive = input.isActive;
  }

  const [updated] = await db
    .update(users)
    .set(updates)
    .where(
      withTenant(
        users,
        organizationId,
        and(eq(users.id, technicianId), eq(users.role, "technician"))!,
      ),
    )
    .returning();

  if (!updated) {
    return null;
  }

  return {
    id: updated.id,
    name: updated.name,
    email: updated.email,
    isActive: updated.isActive,
    createdAt: updated.createdAt.toISOString(),
  };
}

export async function getDashboardStats(
  organizationId: string,
): Promise<DashboardStats> {
  const todayStart = startOfTodayUTC();

  // Use a single aggregate query with CASE statements for all counts.
  // This is much faster than 7 separate count queries (1 DB round-trip vs 7).
  const [result] = await db
    .select({
      pending: count(sql`CASE WHEN ${serviceRequests.status} = 'pending' THEN 1 END`),
      assignedToday: count(
        sql`CASE WHEN ${serviceRequests.status} = 'assigned' AND ${serviceRequests.updatedAt} >= ${todayStart} THEN 1 END`,
      ),
      inProgress: count(sql`CASE WHEN ${serviceRequests.status} = 'in_progress' THEN 1 END`),
      completedToday: count(
        sql`CASE WHEN ${serviceRequests.status} = 'completed' AND ${serviceRequests.completedAt} >= ${todayStart} THEN 1 END`,
      ),
      scheduled: count(sql`CASE WHEN ${serviceRequests.status} = 'scheduled' THEN 1 END`),
      onHold: count(sql`CASE WHEN ${serviceRequests.status} = 'on_hold' THEN 1 END`),
      emergencyOpen: count(
        sql`CASE WHEN ${serviceRequests.urgency} = 'emergency' AND ${serviceRequests.status} IN ${sql`[${OPEN_STATUSES.join(',')}]`} THEN 1 END`,
      ),
      afterHoursToday: count(
        sql`CASE WHEN ${serviceRequests.isAfterHours} = true AND ${serviceRequests.createdAt} >= ${todayStart} THEN 1 END`,
      ),
    })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId));

  return {
    pending: result?.pending ?? 0,
    assignedToday: result?.assignedToday ?? 0,
    inProgress: result?.inProgress ?? 0,
    completedToday: result?.completedToday ?? 0,
    scheduled: result?.scheduled ?? 0,
    onHold: result?.onHold ?? 0,
    emergencyOpen: result?.emergencyOpen ?? 0,
    afterHoursToday: result?.afterHoursToday ?? 0,
  };
}

// The column set every dashboard list query selects, so they all map through
// the same toDashboardRequest() helper below. Kept narrow on purpose: no
// transcript, no decrypted phone/email/address — names only.
const dashboardRequestSelect = {
  id: serviceRequests.id,
  referenceNumber: serviceRequests.referenceNumber,
  customerNameEncrypted: serviceRequests.customerNameEncrypted,
  issueType: serviceRequests.issueType,
  urgency: serviceRequests.urgency,
  status: serviceRequests.status,
  isAfterHours: serviceRequests.isAfterHours,
  assignedToName: users.name,
  arrivalWindowStart: serviceRequests.arrivalWindowStart,
  arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
  followUpDate: serviceRequests.followUpDate,
  holdReason: serviceRequests.holdReason,
  autoAssigned: serviceRequests.autoAssigned,
  createdAt: serviceRequests.createdAt,
} as const;

type DashboardRequestRow = {
  readonly id: string;
  readonly referenceNumber: string;
  readonly customerNameEncrypted: string | null;
  readonly issueType: string;
  readonly urgency: string;
  readonly status: string;
  readonly isAfterHours: boolean;
  readonly assignedToName: string | null;
  readonly arrivalWindowStart: Date | null;
  readonly arrivalWindowEnd: Date | null;
  readonly followUpDate: Date | null;
  readonly holdReason: string | null;
  readonly autoAssigned: boolean;
  readonly createdAt: Date;
};

function toDashboardRequest(row: DashboardRequestRow): DashboardRequest {
  return {
    id: row.id,
    referenceNumber: row.referenceNumber,
    customerName: safeDecrypt(row.customerNameEncrypted),
    issueType: row.issueType,
    urgency: row.urgency,
    status: row.status,
    isAfterHours: row.isAfterHours,
    assignedToName: row.assignedToName,
    arrivalWindowStart: row.arrivalWindowStart?.toISOString() ?? null,
    arrivalWindowEnd: row.arrivalWindowEnd?.toISOString() ?? null,
    followUpDate: row.followUpDate?.toISOString() ?? null,
    holdReason: row.holdReason,
    autoAssigned: row.autoAssigned,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * One tenant-scoped payload for the /admin overview dashboard: the expanded
 * KPI counts, today's scheduled arrival windows, the unassigned urgent/emergency
 * queue, and on-hold requests awaiting a follow-up. All lists are capped and
 * carry decrypted customer NAMES only (no other PII).
 */
export async function getDashboardOverview(
  organizationId: string,
): Promise<DashboardOverview> {
  const todayStart = startOfTodayUTC();
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

  // Run all queries in parallel to reduce latency (1 DB round-trip vs 4 sequential).
  // Neon's pgwire protocol supports multiple concurrent queries per connection.
  const [stats, scheduleRows, attentionRows, followUpRows] = await Promise.all([
    getDashboardStats(organizationId),

    // Today's schedule: any open request whose arrival window starts today.
    db
      .select(dashboardRequestSelect)
      .from(serviceRequests)
      .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          isNotNull(serviceRequests.arrivalWindowStart),
          gte(serviceRequests.arrivalWindowStart, todayStart),
          lt(serviceRequests.arrivalWindowStart, tomorrowStart),
          inArray(serviceRequests.status, [...OPEN_STATUSES]),
        ),
      )
      .orderBy(asc(serviceRequests.arrivalWindowStart))
      .limit(DASHBOARD_LIST_LIMIT),

    // Needs attention: open, unassigned, urgent or emergency — most urgent first.
    db
      .select(dashboardRequestSelect)
      .from(serviceRequests)
      .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          // "Needs attention" = nobody is on it yet. A pending/scheduled request
          // can still carry an assignee (reassign keeps assignedTo), so filter on
          // assignedTo IS NULL, not status alone — otherwise assigned-but-urgent
          // jobs leak into the queue.
          isNull(serviceRequests.assignedTo),
          inArray(serviceRequests.status, [...UNASSIGNED_OPEN_STATUSES]),
          inArray(serviceRequests.urgency, ["emergency", "high"]),
        ),
      )
      // Order by urgency rank (emergency before high), then oldest-first so the
      // longest-waiting request floats to the top.
      .orderBy(
        sql`case ${serviceRequests.urgency} when 'emergency' then 0 else 1 end`,
        asc(serviceRequests.createdAt),
      )
      .limit(DASHBOARD_LIST_LIMIT),

    // On hold and waiting on a follow-up — earliest follow-up first.
    db
      .select(dashboardRequestSelect)
      .from(serviceRequests)
      .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.status, "on_hold"),
          isNotNull(serviceRequests.followUpDate),
        ),
      )
      .orderBy(asc(serviceRequests.followUpDate))
      .limit(DASHBOARD_LIST_LIMIT),
  ]);

  return {
    stats,
    todaySchedule: scheduleRows.map(toDashboardRequest),
    needsAttention: attentionRows.map(toDashboardRequest),
    awaitingFollowUp: followUpRows.map(toDashboardRequest),
  };
}

/**
 * The dispatch board for a single UTC day: one column per ACTIVE technician
 * holding the jobs assigned to them whose arrival window falls that day, plus
 * an "unassigned" pile of scheduled jobs with no tech. Every technician gets a
 * column even with zero jobs so the dispatcher sees who is free.
 *
 * `isoDate` defaults to the current UTC day; an invalid date falls back to
 * today rather than querying a garbage range. Tenant-scoped; decrypted customer
 * NAMES only.
 */
export async function getDispatchBoard(
  organizationId: string,
  isoDate?: string,
): Promise<DispatchBoard> {
  const bounds = (isoDate && utcDayBounds(isoDate)) || utcDayBounds(todayUTCDate())!;

  // The board's job-card select mirrors dashboardRequestSelect but also carries
  // the raw assignedTo id so we can bucket jobs into technician columns.
  const dispatchSelect = {
    ...dashboardRequestSelect,
    assignedTo: serviceRequests.assignedTo,
  } as const;

  const [technicians, jobRows] = await Promise.all([
    getTechnicians(organizationId),
    db
      .select(dispatchSelect)
      .from(serviceRequests)
      .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          isNotNull(serviceRequests.arrivalWindowStart),
          gte(serviceRequests.arrivalWindowStart, bounds.start),
          lt(serviceRequests.arrivalWindowStart, bounds.end),
          inArray(serviceRequests.status, [...OPEN_STATUSES]),
        ),
      )
      .orderBy(asc(serviceRequests.arrivalWindowStart)),
  ]);

  // Seed a bucket for each ACTIVE technician first, so jobs assigned to them
  // route into a real column. A job whose assignee is missing, deactivated, or
  // otherwise not a visible active tech falls through to the unassigned pile
  // rather than silently disappearing.
  const activeTechs = technicians.filter((tech) => tech.isActive);
  const byTech = new Map<string, DashboardRequest[]>(
    activeTechs.map((tech) => [tech.id, [] as DashboardRequest[]]),
  );
  const unassigned: DashboardRequest[] = [];

  for (const row of jobRows) {
    const job = toDashboardRequest(row);
    const bucket = row.assignedTo ? byTech.get(row.assignedTo) : undefined;
    if (bucket) {
      bucket.push(job); // rows are window-ordered, so each bucket stays sorted
    } else {
      unassigned.push(job);
    }
  }

  const columns: readonly DispatchColumn[] = activeTechs.map((tech) => ({
    technicianId: tech.id,
    technicianName: tech.name,
    jobs: byTech.get(tech.id) ?? [],
  }));

  return {
    date: bounds.date,
    columns,
    unassigned,
  };
}

// ─── Scheduling calendar (Stage 2) ───────────────────────────────────────────

/**
 * The scheduling calendar for an arbitrary UTC instant range [startIso, endIso):
 * placed jobs (those with an arrival window) bucketed into a lane per active
 * technician, plus a placed-but-unassigned lane, plus the "to place" unscheduled
 * queue. Reuses dashboardRequestSelect so calendar cards carry the same rich
 * fields (decrypted name, urgency, status) as the dispatch board.
 *
 * The range is a half-open instant window the API computes from the chosen
 * business-day(s) (start = business-tz midnight of the first day, end = midnight
 * after the last). Jobs are matched by arrivalWindowStart falling in the range —
 * the same anchor the dispatch board uses. `days` is supplied by the caller (the
 * business-tz ISO dates being rendered) so the calendar grid and the data agree
 * on which days the view spans, independent of the server's timezone.
 *
 * The window/unscheduled feeds could later come from an HCP-backed source; this
 * function reads our own tables for now (the scheduling-source seam covers the
 * leaner ScheduledJob feed used by conflict detection). Tenant-scoped throughout.
 */
export async function getSchedulingCalendar(
  organizationId: string,
  startIso: string,
  endIso: string,
  days: readonly string[],
): Promise<SchedulingCalendar> {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid calendar range");
  }

  const calendarSelect = {
    ...dashboardRequestSelect,
    assignedTo: serviceRequests.assignedTo,
  } as const;

  const [technicians, placedRows, unscheduledRows, availability] =
    await Promise.all([
    getTechnicians(organizationId),
    // Placed jobs: an arrival window OVERLAPPING the range, in an open state.
    // Half-open overlap (window.start < rangeEnd AND window.end > rangeStart),
    // consistent with checkScheduleConflict — NOT a point test on the start. A
    // POINT test (start within [rangeStart, rangeEnd)) would DROP a job that
    // starts before the range but whose window extends into it (e.g. an evening
    // job spanning a day boundary, or a job opened just before a week view's
    // first midnight). The end bound is STRICT (gt) so a job ending exactly at
    // rangeStart belongs to the prior range, matching the booked-time feed.
    db
      .select(calendarSelect)
      .from(serviceRequests)
      .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          isNotNull(serviceRequests.arrivalWindowStart),
          isNotNull(serviceRequests.arrivalWindowEnd),
          lt(serviceRequests.arrivalWindowStart, end),
          gt(serviceRequests.arrivalWindowEnd, start),
          inArray(serviceRequests.status, [...OPEN_STATUSES]),
        ),
      )
      .orderBy(asc(serviceRequests.arrivalWindowStart)),
    // Unscheduled: open intake not yet fully placed — no tech OR no window.
    db
      .select(dashboardRequestSelect)
      .from(serviceRequests)
      .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          inArray(serviceRequests.status, [...UNASSIGNED_OPEN_STATUSES]),
          or(
            isNull(serviceRequests.assignedTo),
            isNull(serviceRequests.arrivalWindowStart),
          )!,
        ),
      )
      .orderBy(asc(serviceRequests.createdAt))
      .limit(DASHBOARD_LIST_LIMIT),
    // Recurring working hours for every tech — drives S4 out-of-hours shading.
    getTechnicianAvailability(organizationId),
  ]);

  const activeTechs = technicians.filter((tech) => tech.isActive);
  const byTech = new Map<string, DashboardRequest[]>(
    activeTechs.map((tech) => [tech.id, [] as DashboardRequest[]]),
  );
  const unassigned: DashboardRequest[] = [];

  for (const row of placedRows) {
    const job = toDashboardRequest(row);
    const bucket = row.assignedTo ? byTech.get(row.assignedTo) : undefined;
    if (bucket) {
      bucket.push(job); // rows are window-ordered, so each lane stays sorted
    } else {
      unassigned.push(job);
    }
  }

  const lanes: readonly CalendarTechnicianLane[] = activeTechs.map((tech) => ({
    technicianId: tech.id,
    technicianName: tech.name,
    jobs: byTech.get(tech.id) ?? [],
  }));

  return {
    days: [...days],
    lanes,
    unassigned,
    unscheduled: unscheduledRows.map(toDashboardRequest),
    availability: [...availability],
  };
}

/**
 * The MONTH-view payload: every placed job in [startIso, endIso) bucketed by the
 * business day its arrival window starts on, projected onto the supplied grid of
 * business-tz dates (`gridDays`, length 35 or 42 from businessMonthDates).
 *
 * Lightweight on purpose — month view is a read-only overview, so unlike
 * getSchedulingCalendar this fetches NO per-technician lanes, NO availability,
 * and NO unscheduled queue. It reuses the SAME overlap predicate and
 * DashboardRequest projection as the day/week board so chips carry the same rich
 * fields (urgency, status, customer, window). Jobs are bucketed by the business
 * day of their window START — a job is shown on the day it begins. Tenant-scoped.
 */
export async function getMonthCalendar(
  organizationId: string,
  startIso: string,
  endIso: string,
  gridDays: readonly string[],
  month: string,
): Promise<MonthCalendar> {
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start >= end
  ) {
    throw new Error("Invalid month calendar range");
  }

  // Same half-open window-overlap predicate as the day/week board.
  const placedRows = await db
    .select(dashboardRequestSelect)
    .from(serviceRequests)
    .leftJoin(users, eq(serviceRequests.assignedTo, users.id))
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        isNotNull(serviceRequests.arrivalWindowStart),
        isNotNull(serviceRequests.arrivalWindowEnd),
        // Date objects (not ISO strings): the arrival-window columns are
        // timestamptz, matching how the day/week board passes its bounds.
        lt(serviceRequests.arrivalWindowStart, end),
        gt(serviceRequests.arrivalWindowEnd, start),
        inArray(serviceRequests.status, [...OPEN_STATUSES]),
      ),
    )
    .orderBy(asc(serviceRequests.arrivalWindowStart));

  // Bucket window-ordered rows by the business day their window starts on. A row
  // whose start day isn't in the grid (shouldn't happen — the range is built
  // from the grid) is simply dropped from the view.
  const jobsByDay = new Map<string, DashboardRequest[]>(
    gridDays.map((day) => [day, [] as DashboardRequest[]]),
  );
  for (const row of placedRows) {
    if (!row.arrivalWindowStart) continue;
    const startDate = new Date(row.arrivalWindowStart);
    if (Number.isNaN(startDate.getTime())) continue;
    const bucket = jobsByDay.get(businessIsoDate(startDate));
    if (bucket) bucket.push(toDashboardRequest(row)); // already window-ordered
  }

  const monthPrefix = `${month}-`;
  const days: readonly MonthCalendarDay[] = gridDays.map((day) => ({
    day,
    inMonth: day.startsWith(monthPrefix),
    jobs: jobsByDay.get(day) ?? [],
  }));

  return { month, days };
}

/**
 * Count of open requests still needing to be PLACED on the calendar (no tech
 * and/or no arrival window) — the number the admin-nav unscheduled badge shows.
 * A cheap COUNT(*) so it can be fetched on every admin page load. Tenant-scoped.
 */
export async function countUnscheduledRequests(
  organizationId: string,
): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        inArray(serviceRequests.status, [...UNASSIGNED_OPEN_STATUSES]),
        or(
          isNull(serviceRequests.assignedTo),
          isNull(serviceRequests.arrivalWindowStart),
        )!,
      ),
    );
  return result?.value ?? 0;
}
