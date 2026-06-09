/**
 * Scheduling query functions — the data foundation for the admin calendar.
 *
 * Like queries.ts, every function takes organizationId first and scopes through
 * withTenant (the key_links multi-tenancy contract). These are the primitives
 * the calendar UI (S2), conflict detection (S3), and customer slot-picking (S4)
 * build on. They read/write our OWN tables today; an HCP-backed source can
 * replace the availability/jobs reads later behind the scheduling-source seam
 * (see scheduling-source.ts) without changing the calendar.
 */
import {
  eq,
  ne,
  and,
  asc,
  gt,
  lt,
  inArray,
  isNull,
  isNotNull,
  or,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  serviceRequests,
  technicianAvailability,
  users,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { isTerminal, type RequestStatus } from "./request-status";
import { isWindowWithinAvailability } from "./availability-coverage";
import type { ArrivalWindow } from "./arrival-window";
import type {
  AvailabilitySlot,
  AvailabilitySlotInput,
  ScheduledJob,
} from "./types";

/** Statuses that hold a "live" booking on the calendar — a job in one of these
 * states with an arrival window genuinely occupies a technician's time, so it
 * counts for conflict detection and as a scheduled job. Terminal states
 * (completed/cancelled) free the slot. */
const ACTIVE_BOOKING_STATUSES = [
  "pending",
  "assigned",
  "scheduled",
  "in_progress",
  "on_hold",
] as const;

/** Statuses an "unscheduled" request can sit in: still open intake (pending) or
 * booked-as-a-status (scheduled) but missing a tech and/or an arrival window. */
const UNSCHEDULED_STATUSES = ["pending", "scheduled"] as const;

/**
 * Recurring weekly availability rows for the org, or for one technician when
 * `technicianId` is given. Ordered by (technician, weekday, start) so the
 * calendar can lay them out without re-sorting. Tenant-scoped.
 */
export async function getTechnicianAvailability(
  organizationId: string,
  technicianId?: string,
): Promise<readonly AvailabilitySlot[]> {
  const extra: SQL[] = [];
  if (technicianId) {
    extra.push(eq(technicianAvailability.technicianId, technicianId));
  }

  const rows = await db
    .select({
      id: technicianAvailability.id,
      technicianId: technicianAvailability.technicianId,
      dayOfWeek: technicianAvailability.dayOfWeek,
      startMinute: technicianAvailability.startMinute,
      endMinute: technicianAvailability.endMinute,
    })
    .from(technicianAvailability)
    .where(withTenant(technicianAvailability, organizationId, ...extra))
    .orderBy(
      asc(technicianAvailability.technicianId),
      asc(technicianAvailability.dayOfWeek),
      asc(technicianAvailability.startMinute),
    );

  return rows.map((row) => ({
    id: row.id,
    technicianId: row.technicianId,
    dayOfWeek: row.dayOfWeek,
    startMinute: row.startMinute,
    endMinute: row.endMinute,
  }));
}

/**
 * REPLACE a technician's entire availability with `slots`. Delete-then-insert in
 * a single `db.batch` so the swap is atomic (neon-http executes a batch as one
 * non-interactive transaction; it does NOT support db.transaction()). Passing an
 * empty `slots` array clears the technician's availability.
 *
 * Tenant-scoped: the delete is org+tech scoped, and every inserted row carries
 * the org id, so a caller can never write availability into another tenant.
 */
export async function setTechnicianAvailability(
  organizationId: string,
  technicianId: string,
  slots: readonly AvailabilitySlotInput[],
): Promise<void> {
  const deleteStmt = db
    .delete(technicianAvailability)
    .where(
      withTenant(
        technicianAvailability,
        organizationId,
        eq(technicianAvailability.technicianId, technicianId),
      ),
    );

  // No new rows → just clear. A db.batch must be non-empty, so run the delete
  // on its own rather than batching a single statement.
  if (slots.length === 0) {
    await deleteStmt;
    return;
  }

  const insertStmt = db.insert(technicianAvailability).values(
    slots.map((slot) => ({
      organizationId,
      technicianId,
      dayOfWeek: slot.dayOfWeek,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
    })),
  );

  await db.batch([deleteStmt, insertStmt]);
}

/**
 * The core CONFLICT primitive (S3/S4 build on it): the active jobs already
 * booked for `technicianId` whose arrival window overlaps [startIso, endIso).
 * A non-empty result means the proposed window collides with existing work.
 *
 * Overlap is the standard half-open interval test — existing window
 * [existing.start, existing.end) and proposed [proposed.start, proposed.end)
 * overlap iff `existing.start < proposed.end AND proposed.start < existing.end`
 * — so windows that merely touch at an endpoint (e.g. 8–12 then 12–16) do NOT
 * conflict. The second bound MUST be strict (`existing.end > proposed.start`,
 * i.e. `gt`, NOT `gte`): with `gte`, a back-to-back booking whose existing
 * window ends exactly when the new one starts would be falsely flagged.
 * `excludeRequestId` omits a request from the check so RESCHEDULING a job
 * doesn't conflict with its own current window.
 */
export async function checkScheduleConflict(
  organizationId: string,
  technicianId: string,
  startIso: string,
  endIso: string,
  excludeRequestId?: string,
): Promise<readonly ScheduledJob[]> {
  const start = new Date(startIso);
  const end = new Date(endIso);

  const conditions: SQL[] = [
    eq(serviceRequests.assignedTo, technicianId),
    inArray(serviceRequests.status, [...ACTIVE_BOOKING_STATUSES]),
    isNotNull(serviceRequests.arrivalWindowStart),
    isNotNull(serviceRequests.arrivalWindowEnd),
    // Half-open overlap: existing.start < proposed.end AND proposed.start < existing.end.
    // The end bound is STRICT (gt) so a job ending exactly at `start` (a
    // back-to-back booking) does NOT count as a conflict.
    lt(serviceRequests.arrivalWindowStart, end),
    gt(serviceRequests.arrivalWindowEnd, start),
  ];
  if (excludeRequestId) {
    conditions.push(ne(serviceRequests.id, excludeRequestId));
  }

  const rows = await db
    .select({
      id: serviceRequests.id,
      referenceNumber: serviceRequests.referenceNumber,
      status: serviceRequests.status,
      assignedTo: serviceRequests.assignedTo,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, ...conditions))
    .orderBy(asc(serviceRequests.arrivalWindowStart));

  return rows.map(toScheduledJob);
}

/**
 * Active jobs with a concrete arrival window overlapping [startIso, endIso) —
 * the calendar's "booked time" feed (consumed by the scheduling source's
 * getJobs). Half-open overlap, same as checkScheduleConflict but across ALL
 * technicians (and unassigned jobs) in the org.
 */
export async function getScheduledJobsForRange(
  organizationId: string,
  startIso: string,
  endIso: string,
): Promise<readonly ScheduledJob[]> {
  const start = new Date(startIso);
  const end = new Date(endIso);

  const rows = await db
    .select({
      id: serviceRequests.id,
      referenceNumber: serviceRequests.referenceNumber,
      status: serviceRequests.status,
      assignedTo: serviceRequests.assignedTo,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        inArray(serviceRequests.status, [...ACTIVE_BOOKING_STATUSES]),
        isNotNull(serviceRequests.arrivalWindowStart),
        isNotNull(serviceRequests.arrivalWindowEnd),
        // Strict end bound (gt): a job ending exactly at the range start
        // belongs to the prior range, not this one — half-open [start, end).
        lt(serviceRequests.arrivalWindowStart, end),
        gt(serviceRequests.arrivalWindowEnd, start),
      ),
    )
    .orderBy(asc(serviceRequests.arrivalWindowStart));

  return rows.map(toScheduledJob);
}

/**
 * Open requests that still need to be PLACED on the calendar: status
 * pending/scheduled and either unassigned (no technician) OR missing an arrival
 * window. Backs the "unscheduled jobs" view in S2. Oldest first so the
 * longest-waiting request floats to the top. Tenant-scoped.
 */
export async function listUnscheduledRequests(
  organizationId: string,
): Promise<readonly ScheduledJob[]> {
  const rows = await db
    .select({
      id: serviceRequests.id,
      referenceNumber: serviceRequests.referenceNumber,
      status: serviceRequests.status,
      assignedTo: serviceRequests.assignedTo,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    })
    .from(serviceRequests)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        inArray(serviceRequests.status, [...UNSCHEDULED_STATUSES]),
        // "Unscheduled" = not yet fully placed: no tech, or no arrival window.
        or(
          isNull(serviceRequests.assignedTo),
          isNull(serviceRequests.arrivalWindowStart),
        )!,
      ),
    )
    .orderBy(asc(serviceRequests.createdAt));

  return rows.map(toScheduledJob);
}

export type RescheduleRequestResult =
  | {
      readonly ok: true;
      readonly status: RequestStatus;
      readonly scheduledDate: string;
      readonly arrivalWindowStart: string;
      readonly arrivalWindowEnd: string;
      readonly assignedTo: string | null;
      /** Active jobs on the SAME technician whose window overlaps the new one.
       * Empty when unassigned or no clash. SOFT in S3 — surfaced to the
       * dispatcher, not blocked; S4 turns this into hard enforcement. */
      readonly conflicts: readonly ScheduledJob[];
    }
  | { readonly ok: false; readonly reason: "request_not_found" }
  | {
      readonly ok: false;
      readonly reason: "request_terminal";
      readonly currentStatus: RequestStatus;
    };

/**
 * Atomically move a request to a new arrival WINDOW (drag-to-reschedule). Sets
 * `scheduledDate` + `arrivalWindowStart/End` together; the caller resolves the
 * window to UTC instants via calendar-time.arrivalWindowUtcForBusinessDate so the
 * persisted window matches the Eastern grid the dispatcher dragged on.
 *
 * Terminal requests (completed/cancelled) can't be rescheduled — we read the
 * current status first and reject those. The status itself is NOT changed here
 * (reschedule moves the WHEN, not the lifecycle stage); the UPDATE is guarded on
 * the same status we read, which closes the lost-update race with a concurrent
 * status change (the guarded UPDATE matches zero rows if status moved underneath
 * us, surfaced as request_not_found for the caller to retry).
 *
 * Conflict detection is SOFT in this stage: after the write we check the
 * assignee's other active jobs for an overlap (excluding this request) and return
 * any clashes for the dispatcher to see. S4 will enforce. Unassigned jobs have no
 * technician to clash with, so we skip the check.
 *
 * Tenant-scoped: read, write, and the conflict check are all org-scoped.
 */
export async function rescheduleRequest(
  organizationId: string,
  requestId: string,
  arrivalWindow: { readonly start: Date; readonly end: Date },
): Promise<RescheduleRequestResult> {
  const [existing] = await db
    .select({
      status: serviceRequests.status,
      assignedTo: serviceRequests.assignedTo,
    })
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

  const currentStatus = existing.status as RequestStatus;
  if (isTerminal(currentStatus)) {
    return { ok: false, reason: "request_terminal", currentStatus };
  }

  const now = new Date();
  // Guard on the status we just read so a concurrent transition to a terminal
  // state (or any change) makes this UPDATE match zero rows rather than silently
  // rescheduling a request that moved underneath us.
  const [updated] = await db
    .update(serviceRequests)
    .set({
      scheduledDate: arrivalWindow.start,
      arrivalWindowStart: arrivalWindow.start,
      arrivalWindowEnd: arrivalWindow.end,
      updatedAt: now,
    })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, requestId),
          eq(serviceRequests.status, currentStatus),
        )!,
      ),
    )
    .returning({
      status: serviceRequests.status,
      assignedTo: serviceRequests.assignedTo,
      scheduledDate: serviceRequests.scheduledDate,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    });

  if (!updated) {
    // The status-guarded UPDATE matched nothing → a concurrent write moved the
    // row between our read and write. Treat as not-found for a clean retry.
    return { ok: false, reason: "request_not_found" };
  }

  // SOFT conflict check (S3): only meaningful for an assigned job — an
  // unassigned request shares no technician's day. Exclude this request so its
  // own freshly-written window doesn't count as a self-conflict.
  const conflicts = updated.assignedTo
    ? await checkScheduleConflict(
        organizationId,
        updated.assignedTo,
        (updated.arrivalWindowStart ?? arrivalWindow.start).toISOString(),
        (updated.arrivalWindowEnd ?? arrivalWindow.end).toISOString(),
        requestId,
      )
    : [];

  return {
    ok: true,
    status: updated.status as RequestStatus,
    scheduledDate: (updated.scheduledDate ?? arrivalWindow.start).toISOString(),
    arrivalWindowStart: (
      updated.arrivalWindowStart ?? arrivalWindow.start
    ).toISOString(),
    arrivalWindowEnd: (
      updated.arrivalWindowEnd ?? arrivalWindow.end
    ).toISOString(),
    assignedTo: updated.assignedTo,
    conflicts,
  };
}

// ─── Stage 4: drag-to-assign + HARD conflict enforcement ────────────────────

/** The conflict detail returned when a move is BLOCKED (S4). `conflicts` are the
 * target technician's overlapping jobs; `outsideAvailability` is true when the
 * window falls outside the tech's working hours for that weekday. At least one is
 * "active" whenever a placeAndAssign call is blocked. PII-free — ids/refs only. */
export interface ScheduleConflictDetail {
  readonly conflicts: readonly ScheduledJob[];
  readonly outsideAvailability: boolean;
}

export type PlaceAndAssignResult =
  | {
      readonly ok: true;
      readonly status: RequestStatus;
      readonly scheduledDate: string;
      readonly arrivalWindowStart: string;
      readonly arrivalWindowEnd: string;
      readonly assignedTo: string | null;
      /** When the move was committed via `override`, the conflicts that were
       * overridden (so the caller can audit "scheduled despite N clashes").
       * Empty on a clean placement. */
      readonly overriddenConflicts: ScheduleConflictDetail | null;
    }
  | { readonly ok: false; readonly reason: "request_not_found" }
  | {
      readonly ok: false;
      readonly reason: "request_terminal";
      readonly currentStatus: RequestStatus;
    }
  | { readonly ok: false; readonly reason: "technician_not_found" }
  | {
      readonly ok: false;
      readonly reason: "conflict";
      readonly detail: ScheduleConflictDetail;
    };

/** Resolve the technician a placement targets: an explicit `technicianId` (a
 * drag-to-assign), else the request's CURRENT assignee (a pure reschedule).
 * Returns `null` when neither yields a tech (unassigned reschedule). */
function resolveTargetTech(
  explicit: string | undefined,
  currentAssignee: string | null,
): string | null {
  return explicit ?? currentAssignee;
}

/**
 * The atomic S4 mutation behind drag-to-assign + drag-to-reschedule. ONE guarded
 * UPDATE can change BOTH the technician AND the arrival window together — a drop
 * into another tech's lane reassigns AND re-times in a single write, so the board
 * never shows a half-applied move.
 *
 * HARD enforcement (the S3 reschedule was soft): BEFORE committing, the target
 * technician's day is checked for (a) an overlapping active job and (b) whether
 * the window falls within their availability. On a clash we return
 * `reason:"conflict"` WITHOUT writing — the route maps that to a 409 so the
 * client can't be the only gate. Passing `override: true` skips the block and
 * commits anyway, returning the overridden conflicts for the audit trail.
 *
 * Steps, all tenant-scoped:
 *  1. Read the request's status + current assignee (reject not-found / terminal).
 *  2. Resolve the target tech (explicit reassignment, else keep current).
 *  3. If assigning to a NEW tech, verify they're an active technician in the org.
 *  4. Unless overriding, check conflict (overlap, excluding this request) +
 *     availability for the target tech; block on either.
 *  5. Guarded UPDATE (status unchanged, matched on the status we read) sets the
 *     window and — when reassigning — assignedTo.
 *
 * neon-http note: each step is its own statement (no db.transaction, which neon-
 * http rejects); the status-guarded UPDATE closes the lost-update race the same
 * way assignTechnician/rescheduleRequest do.
 */
export async function placeAndAssignRequest(
  organizationId: string,
  requestId: string,
  arrivalWindow: { readonly start: Date; readonly end: Date },
  options: {
    /** Business-day + window the drop landed on — for the availability check. */
    readonly isoDay: string;
    readonly window: ArrivalWindow;
    /** New technician (drag-to-assign). Omit to keep the current assignee. */
    readonly technicianId?: string;
    /** Commit despite a detected conflict/out-of-hours (dispatcher confirmed). */
    readonly override?: boolean;
  },
): Promise<PlaceAndAssignResult> {
  const [existing] = await db
    .select({
      status: serviceRequests.status,
      assignedTo: serviceRequests.assignedTo,
    })
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

  const currentStatus = existing.status as RequestStatus;
  if (isTerminal(currentStatus)) {
    return { ok: false, reason: "request_terminal", currentStatus };
  }

  const reassigning =
    options.technicianId !== undefined &&
    options.technicianId !== existing.assignedTo;

  // Verify a NEW assignee is an active technician in THIS org before we touch
  // the request — mirrors assignTechnician's guard so a drag can't park a job on
  // an admin, a deactivated account, or a user from another tenant.
  if (reassigning) {
    const [tech] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        withTenant(
          users,
          organizationId,
          and(
            eq(users.id, options.technicianId!),
            eq(users.role, "technician"),
            eq(users.isActive, true),
          )!,
        ),
      );
    if (!tech) {
      return { ok: false, reason: "technician_not_found" };
    }
  }

  const targetTech = resolveTargetTech(options.technicianId, existing.assignedTo);

  // Conflict + availability gate. Only meaningful with a target technician — an
  // unassigned placement shares no one's day and has no hours to violate.
  if (!options.override && targetTech) {
    const conflicts = await checkScheduleConflict(
      organizationId,
      targetTech,
      arrivalWindow.start.toISOString(),
      arrivalWindow.end.toISOString(),
      requestId,
    );
    const slots = await getTechnicianAvailability(organizationId, targetTech);
    const within = isWindowWithinAvailability(
      slots,
      options.isoDay,
      options.window,
    );
    if (conflicts.length > 0 || !within) {
      return {
        ok: false,
        reason: "conflict",
        detail: { conflicts, outsideAvailability: !within },
      };
    }
  }

  const now = new Date();
  // Reassignment writes assignedTo too; a pure reschedule leaves it untouched.
  const setValues = reassigning
    ? {
        assignedTo: options.technicianId!,
        scheduledDate: arrivalWindow.start,
        arrivalWindowStart: arrivalWindow.start,
        arrivalWindowEnd: arrivalWindow.end,
        updatedAt: now,
      }
    : {
        scheduledDate: arrivalWindow.start,
        arrivalWindowStart: arrivalWindow.start,
        arrivalWindowEnd: arrivalWindow.end,
        updatedAt: now,
      };

  const [updated] = await db
    .update(serviceRequests)
    .set(setValues)
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, requestId),
          eq(serviceRequests.status, currentStatus),
        )!,
      ),
    )
    .returning({
      status: serviceRequests.status,
      assignedTo: serviceRequests.assignedTo,
      scheduledDate: serviceRequests.scheduledDate,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    });

  if (!updated) {
    // Status-guarded UPDATE matched nothing → a concurrent write moved the row.
    return { ok: false, reason: "request_not_found" };
  }

  // On an OVERRIDE, recompute the detail we overrode so the route can audit it.
  let overriddenConflicts: ScheduleConflictDetail | null = null;
  if (options.override && targetTech) {
    const conflicts = await checkScheduleConflict(
      organizationId,
      targetTech,
      (updated.arrivalWindowStart ?? arrivalWindow.start).toISOString(),
      (updated.arrivalWindowEnd ?? arrivalWindow.end).toISOString(),
      requestId,
    );
    const slots = await getTechnicianAvailability(organizationId, targetTech);
    const within = isWindowWithinAvailability(
      slots,
      options.isoDay,
      options.window,
    );
    if (conflicts.length > 0 || !within) {
      overriddenConflicts = { conflicts, outsideAvailability: !within };
    }
  }

  return {
    ok: true,
    status: updated.status as RequestStatus,
    scheduledDate: (updated.scheduledDate ?? arrivalWindow.start).toISOString(),
    arrivalWindowStart: (
      updated.arrivalWindowStart ?? arrivalWindow.start
    ).toISOString(),
    arrivalWindowEnd: (
      updated.arrivalWindowEnd ?? arrivalWindow.end
    ).toISOString(),
    assignedTo: updated.assignedTo,
    overriddenConflicts,
  };
}

/** Row → ScheduledJob. Windows are non-null in every query that uses this
 * EXCEPT listUnscheduledRequests, where an unplaced request legitimately has a
 * null window — surface that as null rather than a bogus epoch date. */
function toScheduledJob(row: {
  readonly id: string;
  readonly referenceNumber: string;
  readonly status: string;
  readonly assignedTo: string | null;
  readonly arrivalWindowStart: Date | null;
  readonly arrivalWindowEnd: Date | null;
}): ScheduledJob {
  return {
    id: row.id,
    referenceNumber: row.referenceNumber,
    status: row.status,
    assignedTo: row.assignedTo,
    arrivalWindowStart: row.arrivalWindowStart?.toISOString() ?? "",
    arrivalWindowEnd: row.arrivalWindowEnd?.toISOString() ?? "",
  };
}
