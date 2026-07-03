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
  sql,
  type SQL,
} from "drizzle-orm";
import { db } from "@/lib/db";
import {
  serviceRequests,
  technicianAvailability,
  users,
  organizationSettings,
  dispatchDecisions,
  customerLocations,
} from "@/lib/db/schema";
import { haversineKm } from "@/lib/address/photon";
import { BUSINESS_BASE_LOCATION } from "@/lib/config/business-location";
import {
  assessBookingQuality,
  type BookingQualityResult,
} from "@/lib/ai/dispatch/booking-quality";
import { withTenant } from "@/lib/db/tenant";
import { logger } from "@/lib/logger";
import {
  rankTechnicians,
  classifyDispatch,
  type DispatchSignals,
  type RankedTech,
  type DispatchOutcome,
} from "@/lib/ai/dispatch/score";
import { estimateJobDuration } from "@/lib/ai/dispatch/duration";
import { loadDispatchSignals } from "@/lib/ai/dispatch/signals";
import { isTerminal, type RequestStatus } from "./request-status";
import { releaseReservationsForRequest } from "./capacity-reservation-queries";
import { notifyCustomerOfAssignment } from "./notify-assignment";
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

/** Minutes in a day. A slot's [start, end) span lives in [0, 1440] (1440 =
 * end-of-day midnight), measured in business-tz wall clock. */
const MINUTES_PER_DAY = 1440;
const MIN_DAY_OF_WEEK = 0;
const MAX_DAY_OF_WEEK = 6;

/**
 * A rejected availability slot — thrown by setTechnicianAvailability when an
 * input slot is out of range (bad weekday or a non-positive / overflowing
 * [start, end) span). A typed error so the route can map it to a 400 rather than
 * letting impossible data reach the DB (where it would corrupt the open-window
 * math and the out-of-hours shading).
 */
export class InvalidAvailabilitySlotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAvailabilitySlotError";
  }
}

/**
 * Validate one availability slot: an integer weekday in [0, 6] and an integer
 * [startMinute, endMinute) span with 0 <= start < end <= 1440. Throws
 * InvalidAvailabilitySlotError on the first violation. Pure — no I/O.
 */
function validateAvailabilitySlot(slot: AvailabilitySlotInput): void {
  const { dayOfWeek, startMinute, endMinute } = slot;
  if (
    !Number.isInteger(dayOfWeek) ||
    dayOfWeek < MIN_DAY_OF_WEEK ||
    dayOfWeek > MAX_DAY_OF_WEEK
  ) {
    throw new InvalidAvailabilitySlotError(
      `dayOfWeek must be an integer in [${MIN_DAY_OF_WEEK}, ${MAX_DAY_OF_WEEK}], got ${dayOfWeek}`,
    );
  }
  if (!Number.isInteger(startMinute) || !Number.isInteger(endMinute)) {
    throw new InvalidAvailabilitySlotError(
      `startMinute and endMinute must be integers, got ${startMinute}/${endMinute}`,
    );
  }
  if (
    startMinute < 0 ||
    startMinute >= endMinute ||
    endMinute > MINUTES_PER_DAY
  ) {
    throw new InvalidAvailabilitySlotError(
      `slot must satisfy 0 <= startMinute (${startMinute}) < endMinute (${endMinute}) <= ${MINUTES_PER_DAY}`,
    );
  }
}

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
  // Validate EVERY slot up front (before any write) so one bad slot can't leave
  // a partially-replaced availability set, and impossible data never reaches the
  // DB. Throws InvalidAvailabilitySlotError, which the route maps to a 400.
  for (const slot of slots) {
    validateAvailabilitySlot(slot);
  }

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
 *
 * @deprecated SUPERSEDED by {@link placeAndAssignRequest}, which is the LIVE
 * path the reschedule route calls: it does HARD conflict/out-of-hours
 * enforcement and can reassign + re-time in one guarded write, where this S3
 * helper only does a SOFT (non-blocking) conflict surface. No HTTP route still
 * invokes this; it is retained only for tests/back-compat.
 * @internal
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
    /**
     * Only place if the request is still unassigned. Used by background
     * auto-dispatch so it can never overwrite an assignment a human dispatcher
     * made (e.g. a calendar drag) during the several-second scoring window — a
     * drag sets assignedTo without changing status, so the status CAS alone
     * wouldn't catch it. Interactive reassignment leaves this unset.
     */
    readonly requireUnassigned?: boolean;
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

  // Atomic no-double-book guard folded INTO the write: when not overriding, the
  // UPDATE only lands if NO active job for this tech overlaps the target window
  // (half-open, matching checkScheduleConflict). This closes the race between the
  // read-time conflict check above and this write WITHOUT a DB constraint —
  // which would 500 on the intentional override path and every other write path.
  const noDoubleBookGuard =
    !options.override && targetTech
      ? sql`NOT EXISTS (
          SELECT 1 FROM ${serviceRequests} conflict_check
          WHERE conflict_check.organization_id = ${organizationId}
            AND conflict_check.assigned_to = ${targetTech}
            AND conflict_check.id <> ${requestId}
            AND conflict_check.status IN ('pending','assigned','scheduled','in_progress','on_hold')
            AND conflict_check.arrival_window_start IS NOT NULL
            AND conflict_check.arrival_window_end IS NOT NULL
            AND conflict_check.arrival_window_start < ${arrivalWindow.end}
            AND conflict_check.arrival_window_end > ${arrivalWindow.start}
        )`
      : undefined;

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
          // Auto-dispatch only: refuse to place if a human already claimed the
          // job. A calendar drag sets assignedTo but not status, so this is the
          // only guard that catches that race.
          options.requireUnassigned
            ? isNull(serviceRequests.assignedTo)
            : undefined,
          noDoubleBookGuard,
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
    // The guarded UPDATE matched nothing. Disambiguate: a concurrent overlapping
    // booking (the double-book guard) vs the row moving (status/assignee changed).
    if (!options.override && targetTech) {
      const conflicts = await checkScheduleConflict(
        organizationId,
        targetTech,
        arrivalWindow.start.toISOString(),
        arrivalWindow.end.toISOString(),
        requestId,
      );
      if (conflicts.length > 0) {
        return {
          ok: false,
          reason: "conflict",
          detail: { conflicts, outsideAvailability: false },
        };
      }
    }
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

/**
 * Clear a job's placement: null its schedule + arrival window and unassign it,
 * returning it to the unscheduled "to place" queue (status reset to 'pending').
 * The inverse of placeAndAssignRequest — backs drag-back-to-Unscheduled. A single
 * status-guarded UPDATE (neon-http has no transactions); terminal jobs are refused.
 */
export async function unscheduleRequest(
  organizationId: string,
  requestId: string,
): Promise<
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "request_not_found" | "request_terminal";
      readonly currentStatus?: string;
    }
> {
  const [existing] = await db
    .select({ status: serviceRequests.status })
    .from(serviceRequests)
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    );
  if (!existing) return { ok: false, reason: "request_not_found" };
  if (isTerminal(existing.status as RequestStatus)) {
    return { ok: false, reason: "request_terminal", currentStatus: existing.status };
  }

  const [updated] = await db
    .update(serviceRequests)
    .set({
      status: "pending",
      assignedTo: null,
      scheduledDate: null,
      arrivalWindowStart: null,
      arrivalWindowEnd: null,
      updatedAt: new Date(),
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
    .returning({ id: serviceRequests.id });

  if (!updated) return { ok: false, reason: "request_not_found" };
  // Back to the unscheduled pile → its confirm-time capacity hold no longer
  // applies; free it so the band re-opens. Best-effort.
  await releaseReservationsForRequest(organizationId, requestId);
  return { ok: true };
}

/** Org opt-in for scored dispatch. Reads the single column fresh (the settings
 * cache is for the chatbot path; a just-flipped toggle takes effect next booking).
 * organization_settings is keyed by organizationId (PK), so eq is the tenant scope. */
async function isAutoDispatchEnabled(organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: organizationSettings.autoDispatchEnabled })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return row?.enabled ?? false;
}

/** Whether an EXTERNAL scheduler (FieldPulse/HCP) owns this org's calendar. When
 * true, native autodispatch is skipped entirely to avoid double-booking against
 * the system of record. Default 'native' → false (today's behavior). */
async function isExternallyScheduled(organizationId: string): Promise<boolean> {
  const [row] = await db
    .select({ source: organizationSettings.schedulingSource })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return row?.source === "external";
}

/** Pre-assign booking-quality assessment for a request (Probook parity: clean
 * before assign). Presence-only reads — no decrypt/PII — plus an out-of-area check
 * when the job has been geocoded. A missing request is treated as clean so the
 * normal not-found path handles it. */
async function assessBookingQualityForRequest(
  organizationId: string,
  requestId: string,
): Promise<BookingQualityResult> {
  const [row] = await db
    .select({
      addressEncrypted: serviceRequests.addressEncrypted,
      phone: serviceRequests.customerPhoneEncrypted,
      email: serviceRequests.customerEmailEncrypted,
      issueType: serviceRequests.issueType,
      lat: customerLocations.latitude,
      lng: customerLocations.longitude,
    })
    .from(serviceRequests)
    .leftJoin(
      customerLocations,
      eq(serviceRequests.locationId, customerLocations.id),
    )
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    )
    .limit(1);
  if (!row) return { clean: true, issues: [] };

  const distanceKm =
    row.lat != null && row.lng != null
      ? haversineKm(
          BUSINESS_BASE_LOCATION.latitude,
          BUSINESS_BASE_LOCATION.longitude,
          row.lat,
          row.lng,
        )
      : null;

  return assessBookingQuality({
    hasAddress: row.addressEncrypted != null,
    hasContact: row.phone != null || row.email != null,
    hasIssueType: row.issueType != null,
    distanceKm,
  });
}

/** Stamp the confidence-gated autodispatch outcome on the request (annotation for
 * the dispatcher's exception queue). The 'committed' stamp is unconditional (we
 * just placed it); a 'queued_*' stamp is guarded on assignedTo IS NULL so a
 * dispatcher who manually assigned in the race window isn't overwritten with a
 * stale queue verdict. */
async function stampDispatchOutcome(
  organizationId: string,
  requestId: string,
  outcome: DispatchOutcome,
): Promise<void> {
  const cond =
    outcome === "committed"
      ? eq(serviceRequests.id, requestId)
      : and(
          eq(serviceRequests.id, requestId),
          isNull(serviceRequests.assignedTo),
        )!;
  await db
    .update(serviceRequests)
    .set({ autoDispatchOutcome: outcome, updatedAt: new Date() })
    .where(withTenant(serviceRequests, organizationId, cond));
}

/** Audit one SCORED auto-dispatch decision: the ranked candidates (scores +
 * reasons), the chosen tech, and the outcome — so an operator can answer "why
 * this tech?" and the confidence thresholds can be tuned from real override data.
 * Best-effort: a failure here must never affect the dispatch. */
async function recordDispatchDecision(
  organizationId: string,
  requestId: string,
  outcome: DispatchOutcome,
  chosenTechnicianId: string | null,
  ranked: readonly RankedTech[],
): Promise<void> {
  try {
    await db.insert(dispatchDecisions).values({
      organizationId,
      serviceRequestId: requestId,
      outcome,
      chosenTechnicianId,
      topScore: ranked[0]?.score ?? null,
      confidenceGap:
        ranked.length > 1 ? ranked[0]!.score - ranked[1]!.score : null,
      candidates: ranked.map((r) => ({
        technicianId: r.technicianId,
        score: r.score,
        reasons: [...r.reasons],
        // Both travel signals, for the routing-vs-haversine A/B + weight tuning.
        travelKm: r.travelKm,
        travelMinutes: r.travelMinutes,
      })),
    });
  } catch (error) {
    logger.error(
      { error, serviceRequestId: requestId },
      "Failed to record dispatch decision (non-fatal)",
    );
  }
}

/** Compute + persist the on-site duration estimate for a request, once (the AI
 * assist). No-ops if an estimate is already stored — so it's idempotent and never
 * re-calls the LLM. Best-effort: callers run it on the booking's after() path; a
 * failure never affects the booking or the dispatch. */
export async function ensureEstimatedDuration(
  organizationId: string,
  requestId: string,
): Promise<void> {
  const [row] = await db
    .select({
      minutes: serviceRequests.estimatedDurationMinutes,
      jobType: serviceRequests.jobType,
      systemType: serviceRequests.systemType,
      equipmentAgeBand: serviceRequests.equipmentAgeBand,
      description: serviceRequests.description,
    })
    .from(serviceRequests)
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    )
    .limit(1);
  if (!row || row.minutes != null) return; // missing, or already estimated

  const est = await estimateJobDuration(organizationId, {
    jobType: row.jobType,
    systemType: row.systemType,
    equipmentAgeBand: row.equipmentAgeBand,
    description: row.description,
  });
  await db
    .update(serviceRequests)
    .set({
      estimatedDurationMinutes: est.minutes,
      estimatedDurationSource: est.source,
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, requestId),
          isNull(serviceRequests.estimatedDurationMinutes),
        )!,
      ),
    );
}

/** The incoming job's classification, for skill matching. */
async function loadJobClassification(
  organizationId: string,
  requestId: string,
): Promise<DispatchSignals["job"] | null> {
  const [row] = await db
    .select({
      jobType: serviceRequests.jobType,
      systemType: serviceRequests.systemType,
      urgency: serviceRequests.urgency,
    })
    .from(serviceRequests)
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    );
  return row
    ? { jobType: row.jobType, systemType: row.systemType, urgency: row.urgency }
    : null;
}

/** Flag a request as system-assigned (cosmetic; drives the board "Auto" badge).
 * Guarded on the assignee we just placed: if a dispatcher manually reassigned the
 * request in the race window between the assignment and this write, the guard
 * matches nothing and we don't stamp a false "Auto" badge on a human assignment. */
async function markAutoAssigned(
  organizationId: string,
  requestId: string,
  technicianId: string,
): Promise<void> {
  await db
    .update(serviceRequests)
    .set({ autoAssigned: true, updatedAt: new Date() })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, requestId),
          eq(serviceRequests.assignedTo, technicianId),
        )!,
      ),
    );
}

/** Build the ranked, skill-matched technician order for a scored auto-assign.
 * Returns [] when the job IS classified but no tech is skill-matched (the hard
 * gate did its job → leave for a dispatcher). Returns `null` when the job can't
 * be classified at all (request gone, or no jobType/systemType) — the caller
 * must then fall back to first-fit, so an opted-in org never auto-assigns LESS
 * than an opted-out one (no silent regression on unclassified jobs). */
async function rankedTechnicianOrder(
  organizationId: string,
  requestId: string,
  technicianIds: readonly string[],
  isoDay: string,
): Promise<{
  readonly ranked: RankedTech[] | null;
  readonly job: DispatchSignals["job"] | null;
}> {
  const job = await loadJobClassification(organizationId, requestId);
  // Nothing to score on (request missing, or no skill classification captured)
  // → signal the caller to first-fit rather than stranding the job. Return the
  // loaded classification too, so the confidence gate reuses it (no 2nd read).
  if (!job || (job.jobType === null && job.systemType === null))
    return { ranked: null, job };
  const signalsByTech = await loadDispatchSignals(
    organizationId,
    technicianIds,
    job,
    isoDay,
    requestId,
  );
  const candidates: DispatchSignals[] = technicianIds.map((technicianId) => {
    const s = signalsByTech.get(technicianId)!;
    return {
      job,
      tech: {
        technicianId,
        skillJobsCompleted: s.skillJobsCompleted,
        avgRating: s.avgRating,
        sameDayJobCount: s.sameDayJobCount,
        conversionRate: s.conversionRate,
        avgJobRevenueCents: s.avgJobRevenueCents,
        // Travel-aware dispatch: when the job has cached coords + a tech anchor
        // is known this is a real distance and location becomes the dominant
        // score term; null → the scorer is byte-identical to the pre-travel
        // composite (deterministic fallback preserved).
        travelKm: s.travelKm,
        travelMinutes: s.travelMinutes,
      },
    };
  });
  return { ranked: rankTechnicians(candidates), job };
}

/**
 * Read-only top-N technician suggestions for a request — the advisory
 * "exceptions queue" feed (Probook v3 Phase 2). Reuses the SAME scored ranking
 * the auto-assigner uses, so a suggestion matches what auto-assign would do, but
 * is shown REGARDLESS of `auto_dispatch_enabled` (a dispatcher wants the ranked
 * shortlist + reasons even when auto-assign is off) and NEVER commits an
 * assignment — the human still places the job. Returns [] when there are no
 * active techs, or when the job is unclassifiable / no tech is skill-matched.
 */
export async function suggestTechnicians(
  organizationId: string,
  requestId: string,
  limit = 3,
): Promise<RankedTech[]> {
  const techs = await db
    .select({ id: users.id })
    .from(users)
    .where(
      withTenant(
        users,
        organizationId,
        and(eq(users.role, "technician"), eq(users.isActive, true))!,
      ),
    );
  if (techs.length === 0) return [];

  // Score the load signal against the request's scheduled day when set, else today.
  const [req] = await db
    .select({ scheduledDate: serviceRequests.scheduledDate })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
  const isoDay = (req?.scheduledDate ?? new Date()).toISOString().slice(0, 10);

  const { ranked } = await rankedTechnicianOrder(
    organizationId,
    requestId,
    techs.map((t) => t.id),
    isoDay,
  );
  return (ranked ?? []).slice(0, limit);
}

/**
 * Stage 2 — auto-assign a freshly-booked request to a technician for its held
 * window. When the org has opted into scored dispatch (auto_dispatch_enabled),
 * candidates are ranked best-first by a deterministic skill/quality/load score
 * and non-skill-matched techs are dropped; otherwise candidates are the active
 * techs in DB order (today's first-fit — zero behavior change). Either way the
 * conflict + availability gate is delegated to placeAndAssignRequest (which
 * writes assignedTo on success). On a conflict it tries the next tech; on any
 * other failure it stops. Best-effort: returns {assigned:false} when nobody
 * fits, leaving the soft-held window for a dispatcher. Designed to run in
 * after() (off the latency-bound voice/chat turn).
 */
export async function autoAssignBookedRequest(
  organizationId: string,
  requestId: string,
  heldSlot: {
    readonly start: Date;
    readonly end: Date;
    readonly isoDay: string;
    readonly window: ArrivalWindow;
  },
): Promise<{ readonly assigned: boolean; readonly technicianId?: string }> {
  const techs = await db
    .select({ id: users.id })
    .from(users)
    .where(
      withTenant(
        users,
        organizationId,
        and(eq(users.role, "technician"), eq(users.isActive, true))!,
      ),
    );
  // Best-effort: estimate this booking's on-site duration (AI assist; deterministic
  // base + clamped LLM refine). Runs on the booking's after() path; never blocks
  // or fails dispatch.
  await ensureEstimatedDuration(organizationId, requestId).catch(() => {});

  if (techs.length === 0) return { assigned: false };

  // Skip native autodispatch when an external scheduler (FieldPulse/HCP) owns the
  // calendar — assigning here would double-book against the system of record.
  if (await isExternallyScheduled(organizationId)) return { assigned: false };

  // Scored mode (org opt-in) ranks skill-matched techs best-first; otherwise we
  // keep today's first-fit (DB order) for zero behavior change. A job that can't
  // be classified (rankedTechnicianOrder → null) also falls back to first-fit so
  // opting in never strands a job that first-fit would have placed.
  const firstFit = techs.map((t) => t.id);
  const enabled = await isAutoDispatchEnabled(organizationId);

  // Clean-before-assign gate (scored mode only): hold a dirty booking (no address /
  // no contact / out of area) for a human to clean rather than auto-assigning a
  // tech to it. First-fit mode is unchanged (no gate).
  if (enabled) {
    const quality = await assessBookingQualityForRequest(organizationId, requestId);
    if (!quality.clean) {
      await stampDispatchOutcome(organizationId, requestId, "queued_needs_review");
      logger.info(
        { serviceRequestId: requestId, issues: quality.issues },
        "Auto-dispatch: held for review (booking quality)",
      );
      return { assigned: false };
    }
  }

  const rankResult = enabled
    ? await rankedTechnicianOrder(organizationId, requestId, firstFit, heldSlot.isoDay)
    : null;
  const ranked = rankResult?.ranked ?? null;
  // ranked === null  → unclassifiable (or disabled) → first-fit (DB order).
  // ranked === []    → classified but the skill gate dropped everyone → no order.
  const order = ranked ? ranked.map((r) => r.technicianId) : firstFit;
  const rankedById = new Map(ranked?.map((r) => [r.technicianId, r]) ?? []);

  // Confidence-gated commit (scored mode only): a near-tie between the top two,
  // or no skill match at all, is too uncertain to auto-commit — stamp the queue
  // verdict and leave it for a dispatcher's exception queue. First-fit mode
  // (ranked === null) keeps placing as before (no confidence concept).
  if (ranked) {
    // Reuse the classification rankedTechnicianOrder already loaded so an
    // emergency relaxes the confidence gate (Probook-parity priority tier) —
    // no second DB read.
    const decision = classifyDispatch(ranked, rankResult?.job?.urgency);
    if (decision.outcome !== "committed") {
      await stampDispatchOutcome(organizationId, requestId, decision.outcome);
      await recordDispatchDecision(
        organizationId,
        requestId,
        decision.outcome,
        null,
        ranked,
      );
      return { assigned: false };
    }
  }

  for (const technicianId of order) {
    const result = await placeAndAssignRequest(
      organizationId,
      requestId,
      { start: heldSlot.start, end: heldSlot.end },
      {
        isoDay: heldSlot.isoDay,
        window: heldSlot.window,
        technicianId,
        // Background path: never clobber a dispatcher's manual assignment made
        // during the scoring window.
        requireUnassigned: true,
      },
    );
    if (result.ok) {
      await markAutoAssigned(organizationId, requestId, technicianId);
      // Book-on-the-call #2: tell the customer WHO is coming. The confirmation
      // already promised the window (reserved before the response); the tech
      // commits here seconds later in the background, so the follow-up rides
      // the communications queue (consent + quiet hours enforced at send time).
      // notifyCustomerOfAssignment never throws — assignment must not fail
      // over a courtesy message.
      await notifyCustomerOfAssignment({
        organizationId,
        requestId,
        technicianId,
        window: { start: heldSlot.start, end: heldSlot.end },
      });
      // Placed with a real tech → the request now consumes capacity as an
      // ASSIGNED job, so its in-flight hold is redundant. Release it to free the
      // ordinal for the next booking. Best-effort; availability dedupes a
      // lingering hold by request id anyway, so a failed release only under-
      // utilizes (never over-promises).
      await releaseReservationsForRequest(organizationId, requestId);
      if (ranked) {
        await stampDispatchOutcome(organizationId, requestId, "committed");
        await recordDispatchDecision(
          organizationId,
          requestId,
          "committed",
          technicianId,
          ranked,
        );
      }
      // Scored placement → record the explainable decision so an operator can
      // answer "why this tech?". First-fit placements have no score to log.
      const decision = rankedById.get(technicianId);
      if (decision) {
        logger.info(
          {
            serviceRequestId: requestId,
            technicianId,
            score: Number(decision.score.toFixed(3)),
            reasons: decision.reasons,
          },
          "Auto-dispatch: scored assignment",
        );
      }
      return { assigned: true, technicianId };
    }
    // A conflict (busy) or a tech deactivated mid-flight just means THIS tech
    // can't take it — try the next. Only a request-level failure (moved on /
    // terminal / not found) means stop trying entirely.
    if (result.reason !== "conflict" && result.reason !== "technician_not_found") {
      break;
    }
  }
  // Scored mode reached here = the confident top pick(s) couldn't be placed (all
  // conflicted). Record no-fit so the dispatcher sees it in the exception queue.
  if (ranked) {
    await stampDispatchOutcome(organizationId, requestId, "queued_no_fit");
    await recordDispatchDecision(
      organizationId,
      requestId,
      "queued_no_fit",
      null,
      ranked,
    );
  }
  return { assigned: false };
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
