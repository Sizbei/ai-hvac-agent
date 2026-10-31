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
 *  - Step ORDER lives in create-request-flow.ts (pure, unit-tested): refusals
 *    before the insert, and nothing after the insert can fail the create.
 *    This module only supplies the real database/integration dependencies.
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
import { resolveJobTypeForRequest } from "@/lib/admin/job-type-queries";
import { contactBelongsToCustomer } from "@/lib/admin/contact-queries";
import { locationBelongsToCustomer } from "@/lib/admin/location-queries";
import { replaceEntityTags, validateTagTypeIds } from "@/lib/admin/tag-queries";
import { recordStatusEvent } from "@/lib/admin/status-events";
import { generateReferenceNumber } from "@/lib/requests/submit-session-request";
import { persistJobLocation } from "@/lib/requests/persist-job-location";
import { pushJobToHcp } from "@/lib/integrations/housecall-pro/job-sync";
import { pushJobToFieldpulse } from "@/lib/integrations/fieldpulse/job-sync";
import { syncRequestToCalendar } from "@/lib/integrations/google-calendar/sync";
import { logger } from "@/lib/logger";
import { sanitizeAddress } from "@/lib/ai/sanitize-fields";
import {
  planSchedule,
  requestContactSnapshot,
  resolveJobType,
  type CreateRequestInput,
  type SchedulePlan,
} from "./create-request";
import {
  runCreateRequest,
  type ArrivalRange,
  type CreateAdminRequestResult,
  type CreateRequestDeps,
} from "./create-request-flow";
import { ADMIN_SESSION_TOKEN_PREFIX } from "./stand-in-session";

export type { CreateAdminRequestResult, CreateScheduleOutcome } from "./create-request-flow";

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

  // Inline: what the dispatcher typed, through the same sanitizers the
  // customer row got. Existing: copy the customer's encrypted blobs across
  // (same key + IV-per-blob, as membership-visit generation does).
  const snapshot = requestContactSnapshot(input.customer);
  if (snapshot) {
    return {
      id: row.id,
      nameEncrypted: encrypt(snapshot.name),
      phoneEncrypted: snapshot.phone ? encrypt(snapshot.phone) : null,
      emailEncrypted: snapshot.email ? encrypt(snapshot.email) : null,
    };
  }
  return {
    id: row.id,
    nameEncrypted: row.nameEncrypted,
    phoneEncrypted: row.phoneEncrypted,
    emailEncrypted: row.emailEncrypted,
  };
}

async function isActiveTechnician(organizationId: string, technicianId: string): Promise<boolean> {
  const [tech] = await db
    .select({ id: users.id })
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
    )
    .limit(1);
  return Boolean(tech);
}

async function technicianWindowClash(
  organizationId: string,
  technicianId: string,
  plan: Extract<SchedulePlan, { kind: "assign" }>,
  window: ArrivalRange,
): Promise<ScheduleConflictDetail | null> {
  const [conflicts, slots] = await Promise.all([
    checkScheduleConflict(
      organizationId,
      technicianId,
      window.start.toISOString(),
      window.end.toISOString(),
    ),
    getTechnicianAvailability(organizationId, technicianId),
  ]);
  const within = isWindowWithinAvailability(slots, plan.isoDay, plan.window);
  return conflicts.length > 0 || !within ? { conflicts, outsideAvailability: !within } : null;
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

export async function createAdminRequest(params: {
  readonly organizationId: string;
  readonly userId: string;
  readonly input: CreateRequestInput;
  readonly ipAddress: string | null;
}): Promise<CreateAdminRequestResult> {
  const { organizationId, userId, input, ipAddress } = params;
  const plan = planSchedule(input.schedule);
  const jobTypeRow = input.jobTypeId
    ? await resolveJobTypeForRequest(organizationId, input.jobTypeId)
    : null;
  if (input.jobTypeId && !jobTypeRow) return { ok: false, reason: "job_type_not_found" };
  if (input.customer.kind === "existing") {
    const { customerId } = input.customer;
    if (
      input.contactId &&
      !(await contactBelongsToCustomer(organizationId, customerId, input.contactId))
    ) {
      return { ok: false, reason: "contact_not_owned" };
    }
    if (
      input.locationId &&
      !(await locationBelongsToCustomer(organizationId, customerId, input.locationId))
    ) {
      return { ok: false, reason: "location_not_owned" };
    }
  }
  const tags = await validateTagTypeIds(organizationId, "job", input.tagTypeIds);
  if (!tags.ok) return { ok: false, reason: "unknown_tag" };
  // The server derives the enum from the row; a client-sent jobType is ignored when jobTypeId is set.
  const jobType = jobTypeRow ? jobTypeRow.kind : resolveJobType(input.issueType, input.jobType);

  const deps: CreateRequestDeps<ResolvedCustomer> = {
    verifyTechnician: (technicianId) => isActiveTechnician(organizationId, technicianId),
    checkTechnicianWindow: (technicianId, assignPlan, window) =>
      technicianWindowClash(organizationId, technicianId, assignPlan, window),
    resolveCustomer: () => resolveCustomer(organizationId, input),

    async insertRequest(customer, window) {
      const [settingsRow] = await db
        .select({ afterHoursConfig: organizationSettings.afterHoursConfig })
        .from(organizationSettings)
        .where(eq(organizationSettings.organizationId, organizationId))
        .limit(1);
      const afterHours = isAfterHours(
        window?.start ?? new Date(),
        resolveAfterHoursConfig(settingsRow?.afterHoursConfig ?? null),
      );
      const sessionId = randomUUID();
      const requestId = randomUUID();
      const referenceNumber = generateReferenceNumber();
      const now = new Date();

      // One atomic neon-http batch (no db.transaction on neon-http): stand-in
      // session + request + audit row commit together or not at all.
      await db.batch([
        db.insert(customerSessions).values({
          id: sessionId,
          organizationId,
          token: `${ADMIN_SESSION_TOKEN_PREFIX}${sessionId}`,
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
          jobTypeId: jobTypeRow?.id ?? null,
          contactId: input.contactId,
          locationId: input.locationId,
          ...(jobTypeRow
            ? {
                estimatedDurationMinutes: jobTypeRow.defaultDurationMinutes,
                estimatedDurationSource: "job_type",
              }
            : {}),
          urgency: input.urgency,
          description: input.description,
          customerNameEncrypted: customer.nameEncrypted,
          customerPhoneEncrypted: customer.phoneEncrypted,
          customerEmailEncrypted: customer.emailEncrypted,
          addressEncrypted: encrypt(sanitizeAddress(input.address)),
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
            jobTypeId: jobTypeRow?.id ?? null,
            contactId: input.contactId,
            locationId: input.locationId,
            tagTypeIds: tags.ids,
            urgency: input.urgency,
            schedule: plan.kind,
            technicianId: plan.kind === "assign" ? plan.technicianId : null,
            override: input.override,
          }),
          ipAddress,
        }),
      ]);
      return { requestId, referenceNumber };
    },

    // Initial status event, awaited (best-effort; never throws) so it is
    // ordered before the placement's "assigned" event.
    async recordCreated(requestId) {
      if (tags.ids.length > 0) {
        try {
          await replaceEntityTags(organizationId, "job", requestId, tags.ids);
        } catch (error: unknown) {
          logger.error(
            { error, serviceRequestId: requestId },
            "Office booking saved but tags failed",
          );
        }
      }
      await recordStatusEvent({
        organizationId,
        serviceRequestId: requestId,
        fromStatus: null,
        toStatus: "pending",
        actorType: "human",
        actorId: userId,
      });
    },

    async place(requestId, placedPlan, window, override) {
      const result = await placeAndAssignRequest(organizationId, requestId, window, {
        isoDay: placedPlan.isoDay,
        window: placedPlan.window,
        technicianId: placedPlan.kind === "assign" ? placedPlan.technicianId : undefined,
        override,
        // The assignment is part of CREATING the request, not a dispatcher
        // responding to a waiting one: tag its status event "system" so the
        // human first-response KPI doesn't log a ~0s response per booking.
        // (No actingUserId either: a brand-new request has no autopilot
        // decision row for override telemetry to label.)
        assignmentActor: "system",
      });
      if (!result.ok) {
        logger.warn(
          { serviceRequestId: requestId, reason: result.reason },
          "Office booking created the request but could not place it",
        );
        return { ok: false, reason: result.reason };
      }
      return {
        ok: true,
        arrivalWindowStart: result.arrivalWindowStart,
        arrivalWindowEnd: result.arrivalWindowEnd,
        assignedTo: result.assignedTo,
        overridden: result.overriddenConflicts !== null,
      };
    },

    // placeAndAssignRequest sets assignee + window but leaves status alone; the
    // technician app lists only assigned/scheduled/... jobs, so flip pending →
    // assigned (assignTechnician's target), guarded on pending + this assignee.
    async markAssigned(requestId, technicianId) {
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
              eq(serviceRequests.assignedTo, technicianId),
            )!,
          ),
        );
    },

    reserveCapacity: (requestId, isoDay, window) =>
      holdBandCapacity(organizationId, requestId, isoDay, window),

    // Background mirrors, as on the intake path. Degrade-safe no-ops when an
    // integration isn't connected.
    scheduleBackground(requestId, customer, placed) {
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
      if (placed) after(() => syncRequestToCalendar(organizationId, requestId));
      logger.info({ serviceRequestId: requestId }, "Office request created");
    },

    logError(error, context) {
      logger.error(
        { error, ...context },
        "Office booking step failed after the request was saved (request kept)",
      );
    },
  };

  return runCreateRequest(deps, input);
}
