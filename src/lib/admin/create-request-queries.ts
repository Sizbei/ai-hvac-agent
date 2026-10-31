/**
 * Office booking write path — POST /api/admin/requests.
 *
 * Mirrors submit-session-request.ts (the AI intake write) for a request a
 * dispatcher keys in: dedupe-aware customer upsert, "Do Not Service" guard,
 * encrypted contact snapshot, reference number, after-hours flag, and ONE
 * db.batch for session + request + audit. Differences, all deliberate:
 *
 *  - service_requests.session_id is NOT NULL, so the request gets a synthetic
 *    "submitted" session (token `admin-<id>`), the same way membership visits
 *    and the FieldPulse import do.
 *  - The scheduling conflict gate runs BEFORE the insert, so a 409 never leaves
 *    an orphan request behind and the "schedule anyway" retry can't create a
 *    duplicate. placeAndAssignRequest re-checks atomically afterwards; if a
 *    concurrent booking wins that race the request still exists, unscheduled,
 *    and the caller is told so.
 *
 * Every read and write is scoped by the session's organizationId.
 */
import { after } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  auditLog,
  customerSessions,
  customers,
  organizationSettings,
  serviceRequests,
  users,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { encrypt } from "@/lib/crypto";
import { upsertCustomerByContact } from "@/lib/admin/crm-queries";
import { resolveAfterHoursConfig, isAfterHours } from "@/lib/admin/after-hours";
import { arrivalWindowUtcForBusinessDate } from "@/lib/admin/calendar-time";
import { isWindowWithinAvailability } from "@/lib/admin/availability-coverage";
import {
  checkScheduleConflict,
  getTechnicianAvailability,
  placeAndAssignRequest,
  type ScheduleConflictDetail,
} from "@/lib/admin/scheduling-queries";
import { getOpenAvailability } from "@/lib/admin/availability-queries";
import { reserveCeilingForBand } from "@/lib/admin/capacity-hold";
import { reserveCapacitySlot } from "@/lib/admin/capacity-reservation-queries";
import { recordStatusEvent } from "@/lib/admin/status-events";
import { generateReferenceNumber } from "@/lib/requests/submit-session-request";
import { persistJobLocation } from "@/lib/requests/persist-job-location";
import { pushJobToHcp } from "@/lib/integrations/housecall-pro/job-sync";
import { pushJobToFieldpulse } from "@/lib/integrations/fieldpulse/job-sync";
import { syncRequestToCalendar } from "@/lib/integrations/google-calendar/sync";
import { logger } from "@/lib/logger";
import {
  planSchedule,
  resolveJobType,
  type CreateRequestInput,
  type SchedulePlan,
} from "./create-request";

/** What happened to the optional schedule after the request was written. */
export type CreateScheduleOutcome =
  | { readonly kind: "none" }
  | {
      readonly kind: "placed";
      readonly arrivalWindowStart: string;
      readonly arrivalWindowEnd: string;
      readonly assignedTo: string | null;
      readonly overridden: boolean;
    }
  /** The request exists but the window could not be booked (lost a race). */
  | { readonly kind: "failed" };

export type CreateAdminRequestResult =
  | {
      readonly ok: true;
      readonly requestId: string;
      readonly referenceNumber: string;
      readonly schedule: CreateScheduleOutcome;
    }
  | { readonly ok: false; readonly reason: "customer_not_found" }
  | { readonly ok: false; readonly reason: "do_not_service" }
  | { readonly ok: false; readonly reason: "technician_not_found" }
  | {
      readonly ok: false;
      readonly reason: "conflict";
      readonly detail: ScheduleConflictDetail;
    };

interface ResolvedCustomer {
  readonly id: string;
  readonly nameEncrypted: string | null;
  readonly phoneEncrypted: string | null;
  readonly emailEncrypted: string | null;
}

async function resolveCustomer(
  organizationId: string,
  input: CreateRequestInput,
): Promise<ResolvedCustomer | "not_found" | "do_not_service"> {
  const customerId =
    input.customer.kind === "existing"
      ? input.customer.customerId
      : await upsertCustomerByContact(organizationId, {
          name: input.customer.name,
          phone: input.customer.phone,
          email: input.customer.email,
          address: input.address,
        });

  const [row] = await db
    .select({
      id: customers.id,
      nameEncrypted: customers.nameEncrypted,
      phoneEncrypted: customers.phoneEncrypted,
      emailEncrypted: customers.emailEncrypted,
      doNotService: customers.doNotService,
    })
    .from(customers)
    .where(
      withTenant(
        customers,
        organizationId,
        and(eq(customers.id, customerId), isNull(customers.archivedAt))!,
      ),
    )
    .limit(1);
  if (!row) return "not_found";
  if (row.doNotService) return "do_not_service";

  // Inline: snapshot exactly what the dispatcher typed (as submit-session does).
  // Existing: copy the customer's encrypted blobs across (same key + IV-per-
  // blob, as membership-visit generation does) — no decrypt round-trip.
  if (input.customer.kind === "inline") {
    return {
      id: row.id,
      nameEncrypted: encrypt(input.customer.name),
      phoneEncrypted: input.customer.phone ? encrypt(input.customer.phone) : null,
      emailEncrypted: input.customer.email ? encrypt(input.customer.email) : null,
    };
  }
  return {
    id: row.id,
    nameEncrypted: row.nameEncrypted,
    phoneEncrypted: row.phoneEncrypted,
    emailEncrypted: row.emailEncrypted,
  };
}

/** Pre-insert gate for the assign path: the technician must be an active
 * technician in this org, and (unless overriding) the window must be clear. */
async function preflightAssign(
  organizationId: string,
  plan: Extract<SchedulePlan, { kind: "assign" }>,
  window: { readonly start: Date; readonly end: Date },
  override: boolean,
): Promise<"ok" | "technician_not_found" | ScheduleConflictDetail> {
  const [tech] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      withTenant(
        users,
        organizationId,
        and(
          eq(users.id, plan.technicianId),
          eq(users.role, "technician"),
          eq(users.isActive, true),
        )!,
      ),
    )
    .limit(1);
  if (!tech) return "technician_not_found";
  if (override) return "ok";

  const [conflicts, slots] = await Promise.all([
    checkScheduleConflict(
      organizationId,
      plan.technicianId,
      window.start.toISOString(),
      window.end.toISOString(),
    ),
    getTechnicianAvailability(organizationId, plan.technicianId),
  ]);
  const within = isWindowWithinAvailability(slots, plan.isoDay, plan.window);
  if (conflicts.length > 0 || !within) {
    return { conflicts, outsideAvailability: !within };
  }
  return "ok";
}

/** Window without a technician: hold a unit of band capacity so the slot the
 * office just promised stops showing as open. Best-effort — the placement
 * already stands; a full band only means the hold isn't recorded. */
async function holdBandCapacity(
  organizationId: string,
  requestId: string,
  isoDay: string,
  window: string,
): Promise<void> {
  try {
    const availability = await getOpenAvailability(organizationId, [isoDay]);
    await reserveCapacitySlot({
      organizationId,
      day: isoDay,
      window,
      ceiling: reserveCeilingForBand(availability, isoDay, window),
      serviceRequestId: requestId,
    });
  } catch (error: unknown) {
    logger.error(
      { error, serviceRequestId: requestId },
      "Office booking capacity hold failed (non-fatal)",
    );
  }
}

async function applySchedule(
  organizationId: string,
  requestId: string,
  plan: Exclude<SchedulePlan, { kind: "none" }>,
  window: { readonly start: Date; readonly end: Date },
  override: boolean,
  actingUserId: string,
): Promise<CreateScheduleOutcome> {
  const result = await placeAndAssignRequest(organizationId, requestId, window, {
    isoDay: plan.isoDay,
    window: plan.window,
    technicianId: plan.kind === "assign" ? plan.technicianId : undefined,
    override,
    actingUserId,
  });
  if (!result.ok) {
    logger.warn(
      { serviceRequestId: requestId, reason: result.reason },
      "Office booking created the request but could not place it",
    );
    return { kind: "failed" };
  }

  if (plan.kind === "assign") {
    // placeAndAssignRequest sets the assignee + window and records the
    // first-assignment status event but leaves status alone; the technician app
    // lists only assigned/scheduled/... jobs, so flip pending → assigned here
    // (the same target assignTechnician uses). Guarded on the row still being
    // pending + this assignee.
    await db
      .update(serviceRequests)
      .set({ status: "assigned", updatedAt: new Date() })
      .where(
        withTenant(
          serviceRequests,
          organizationId,
          and(
            eq(serviceRequests.id, requestId),
            eq(serviceRequests.status, "pending"),
            eq(serviceRequests.assignedTo, plan.technicianId),
          )!,
        ),
      );
  } else {
    await holdBandCapacity(organizationId, requestId, plan.isoDay, plan.window);
  }

  return {
    kind: "placed",
    arrivalWindowStart: result.arrivalWindowStart,
    arrivalWindowEnd: result.arrivalWindowEnd,
    assignedTo: result.assignedTo,
    overridden: result.overriddenConflicts !== null,
  };
}

export async function createAdminRequest(params: {
  readonly organizationId: string;
  readonly userId: string;
  readonly input: CreateRequestInput;
  readonly ipAddress: string | null;
}): Promise<CreateAdminRequestResult> {
  const { organizationId, userId, input, ipAddress } = params;
  const plan = planSchedule(input.schedule);
  const window =
    plan.kind === "none"
      ? null
      : arrivalWindowUtcForBusinessDate(plan.isoDay, plan.window);

  // Gate the technician + conflicts BEFORE anything is written.
  if (plan.kind === "assign" && window) {
    const gate = await preflightAssign(organizationId, plan, window, input.override);
    if (gate === "technician_not_found") {
      return { ok: false, reason: "technician_not_found" };
    }
    if (gate !== "ok") return { ok: false, reason: "conflict", detail: gate };
  }

  const settingsPromise = db
    .select({ afterHoursConfig: organizationSettings.afterHoursConfig })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);

  const customer = await resolveCustomer(organizationId, input);
  if (customer === "not_found") return { ok: false, reason: "customer_not_found" };
  if (customer === "do_not_service") return { ok: false, reason: "do_not_service" };

  const [settingsRow] = await settingsPromise;
  const afterHours = isAfterHours(
    window?.start ?? new Date(),
    resolveAfterHoursConfig(settingsRow?.afterHoursConfig ?? null),
  );

  const sessionId = randomUUID();
  const requestId = randomUUID();
  const referenceNumber = generateReferenceNumber();
  const jobType = resolveJobType(input.issueType, input.jobType);
  const now = new Date();

  // One atomic neon-http batch (no db.transaction on neon-http): synthetic
  // session + request + audit row commit together or not at all.
  await db.batch([
    db.insert(customerSessions).values({
      id: sessionId,
      organizationId,
      token: `admin-${sessionId}`,
      status: "submitted",
      channel: "web",
      customerId: customer.id,
      createdAt: now,
      updatedAt: now,
    }),
    db.insert(serviceRequests).values({
      id: requestId,
      organizationId,
      sessionId,
      customerId: customer.id,
      status: "pending",
      issueType: input.issueType,
      jobType,
      urgency: input.urgency,
      description: input.description,
      customerNameEncrypted: customer.nameEncrypted,
      customerPhoneEncrypted: customer.phoneEncrypted,
      customerEmailEncrypted: customer.emailEncrypted,
      addressEncrypted: encrypt(input.address),
      referenceNumber,
      systemType: input.systemType,
      accessNotes: input.accessNotes,
      preferredWindow: input.preferredWindow,
      isAfterHours: afterHours,
    }),
    db.insert(auditLog).values({
      organizationId,
      userId,
      actorType: "human",
      action: "service_request_created",
      entity: "service_request",
      entityId: requestId,
      // ids / enums only — never customer PII.
      details: JSON.stringify({
        source: "admin",
        customerId: customer.id,
        customerMode: input.customer.kind,
        issueType: input.issueType,
        jobType,
        urgency: input.urgency,
        schedule: plan.kind,
        technicianId: plan.kind === "assign" ? plan.technicianId : null,
        override: input.override,
      }),
      ipAddress,
    }),
  ]);

  // Initial status event, awaited (best-effort; never throws) so it is ordered
  // before the placement's "assigned" event for dwell-time KPIs.
  await recordStatusEvent({
    organizationId,
    serviceRequestId: requestId,
    fromStatus: null,
    toStatus: "pending",
    actorType: "human",
    actorId: userId,
  });

  const schedule: CreateScheduleOutcome =
    plan.kind === "none" || !window
      ? { kind: "none" }
      : await applySchedule(organizationId, requestId, plan, window, input.override, userId);

  // Background mirrors, as on the intake path. All degrade-safe no-ops when an
  // integration isn't connected.
  after(() =>
    persistJobLocation({
      organizationId,
      customerId: customer.id,
      serviceRequestId: requestId,
      address: input.address,
    }),
  );
  after(() => pushJobToHcp(organizationId, requestId));
  after(() => pushJobToFieldpulse(organizationId, requestId));
  if (schedule.kind === "placed") {
    after(() => syncRequestToCalendar(organizationId, requestId));
  }

  logger.info({ serviceRequestId: requestId, referenceNumber }, "Office request created");
  return { ok: true, requestId, referenceNumber, schedule };
}
