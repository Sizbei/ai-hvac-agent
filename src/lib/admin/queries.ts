/**
 * Database query functions for admin operations.
 *
 * Every query function takes organizationId as its first parameter
 * and uses withTenant to enforce multi-tenancy (key_links contract).
 */
import { eq, and, sql, count, desc, asc, gte, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests, users, messages, requestStatusEnum } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import type {
  AdminRequest,
  AdminRequestDetail,
  TechnicianRecord,
  DashboardStats,
  RequestFilters,
  CreateTechnicianInput,
  UpdateTechnicianInput,
  TranscriptMessage,
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

  const baseConditions =
    filters.status && validStatuses.includes(filters.status)
      ? withTenant(
          serviceRequests,
          organizationId,
          eq(serviceRequests.status, filters.status as RequestStatus),
        )
      : withTenant(serviceRequests, organizationId);

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
  };
}

/** Request statuses from which a (re)assignment is allowed. Once work has
 * started (in_progress) or the request is closed (completed/cancelled),
 * assigning a technician would silently discard that state, so we refuse. */
const ASSIGNABLE_STATUSES = ["pending", "assigned"] as const;

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
      email: input.email,
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
