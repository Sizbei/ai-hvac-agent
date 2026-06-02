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
  gte,
  inArray,
  ilike,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  serviceRequests,
  requestNotes,
  users,
  messages,
  requestStatusEnum,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { normalizeEmail } from "./staff-queries";
import { decrypt } from "@/lib/crypto";
import {
  canTransition,
  type RequestStatus,
} from "./request-status";
import type {
  AdminRequest,
  AdminRequestDetail,
  TechnicianRecord,
  DashboardStats,
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
      completedAt: serviceRequests.completedAt,
      createdAt: serviceRequests.createdAt,
      updatedAt: serviceRequests.updatedAt,
      sessionId: serviceRequests.sessionId,
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
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    transcript,
    notes,
  };
}

/** Request statuses from which an initial assignment is allowed. Assigning
 * flips the status to "assigned", so from "in_progress" it would regress and
 * discard progress — that case is handled by reassignTechnician instead, which
 * preserves the status. Terminal states (completed/cancelled) are never
 * assignable. */
const ASSIGNABLE_STATUSES = ["pending", "assigned"] as const;

/** Statuses from which a REASSIGNMENT (changing the assignee without resetting
 * the lifecycle) is allowed: a request that already has work in flight. */
const REASSIGNABLE_STATUSES = ["assigned", "in_progress"] as const;

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
    // non-assignable state. Disambiguate so the caller can explain why.
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
      reason: "request_not_assignable",
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

  return { ok: true, status: updated.status };
}

export type ScheduleRequestResult =
  | { readonly ok: true; readonly scheduledDate: string | null }
  | { readonly ok: false; readonly reason: "request_not_found" };

/**
 * Sets (or clears, with `null`) a request's scheduled service date. Org-scoped.
 * Independent of status — a dispatcher can schedule a pending or assigned
 * request before work starts.
 */
export async function scheduleRequest(
  organizationId: string,
  requestId: string,
  scheduledDate: Date | null,
): Promise<ScheduleRequestResult> {
  const [updated] = await db
    .update(serviceRequests)
    .set({ scheduledDate, updatedAt: new Date() })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.id, requestId),
      ),
    )
    .returning({ scheduledDate: serviceRequests.scheduledDate });

  if (!updated) {
    return { ok: false, reason: "request_not_found" };
  }

  return {
    ok: true,
    scheduledDate: updated.scheduledDate?.toISOString() ?? null,
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

  const [pendingResult] = await db
    .select({ value: count() })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.status, "pending"),
      ),
    );

  const [assignedTodayResult] = await db
    .select({ value: count() })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.status, "assigned"),
        gte(serviceRequests.updatedAt, todayStart),
      ),
    );

  const [inProgressResult] = await db
    .select({ value: count() })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.status, "in_progress"),
      ),
    );

  const [completedTodayResult] = await db
    .select({ value: count() })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        eq(serviceRequests.status, "completed"),
        gte(serviceRequests.completedAt, todayStart),
      ),
    );

  return {
    pending: pendingResult?.value ?? 0,
    assignedToday: assignedTodayResult?.value ?? 0,
    inProgress: inProgressResult?.value ?? 0,
    completedToday: completedTodayResult?.value ?? 0,
  };
}
