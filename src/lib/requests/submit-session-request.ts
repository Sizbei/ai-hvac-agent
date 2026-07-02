/**
 * Channel-agnostic service-request submission.
 *
 * The single write path that turns a completed intake session into a real
 * `service_requests` row (+ session status, audit log, HCP push, equipment
 * record). Extracted from the web confirm route so the PHONE channel can
 * auto-submit a completed call — before this, a finished voice intake promised
 * "I'll get this over to our team" while nothing was ever created.
 *
 * Callers own channel-specific concerns (CSRF/rate limiting/state-transition
 * guards for web; Twilio signature for voice) and pass a fully VALIDATED
 * ServiceRequestData. This module owns the canonical effects:
 *   1. CRM customer upsert (blind-index deduped)
 *   2. "Do Not Service" guard
 *   3. confirm-time capacity hold (soft-booking fallback)
 *   4. after-hours flag derivation (keyed to when the technician goes out)
 *   5. atomic batch: request insert + session→submitted + audit log
 *   6. background: Housecall Pro job push + customer-equipment record
 */
import { after } from "next/server";
import { and, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  customerSessions,
  serviceRequests,
  auditLog,
  customers,
  organizationSettings,
  communicationPreferences,
} from "@/lib/db/schema";
import { recordStatusEvent } from "@/lib/admin/status-events";
import { summarizeAndClassifySession } from "@/lib/ai/session-outcome";
import {
  resolveAfterHoursConfig,
  isAfterHours,
} from "@/lib/admin/after-hours";
import { encrypt } from "@/lib/crypto";
import {
  jobTypeForIssue,
  type ServiceRequestData,
} from "@/lib/ai/extraction-schema";
import { upsertCustomerByContact } from "@/lib/admin/crm-queries";
import {
  getOpenAvailability,
  businessDaysFrom,
  businessTodayIso,
} from "@/lib/admin/availability-queries";
import {
  pickBookableSlot,
  arrivalWindowForSlot,
  reserveCeilingForBand,
} from "@/lib/admin/capacity-hold";
import {
  reserveCapacitySlot,
  releaseReservationById,
} from "@/lib/admin/capacity-reservation-queries";
import { pushJobToHcp } from "@/lib/integrations/housecall-pro/job-sync";
import { pushJobToFieldpulse } from "@/lib/integrations/fieldpulse/job-sync";
import type { ArrivalWindow } from "@/lib/admin/arrival-window";
import { recordCustomerEquipment } from "@/lib/admin/crm-equipment-queries";
import { buildEquipmentFromIntake } from "@/lib/admin/equipment-from-intake";
import { appendEvent } from "@/lib/context/thread";
import { persistJobLocation } from "@/lib/requests/persist-job-location";
import { logger } from "@/lib/logger";

export function generateReferenceNumber(): string {
  // Format: HVAC-XXXXXXXX (8 random hex chars)
  return `HVAC-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * Confirm-time capacity hold (calendar-robustness stages 2 + 3).
 *
 * Re-verifies the customer's preferred window against CURRENT availability
 * right before the write and, when the band still has an opening, turns the
 * soft `preferredWindow` label into a CONCRETE arrival window AND atomically
 * RESERVES a unit of that band's capacity (capacity_reservations) so two
 * concurrent confirms can't both take the last opening. The UNIQUE constraint is
 * the compare-and-swap: if the band is full at claim time the reserve returns
 * null → soft booking. NEVER blocks the lead: any failure or a full band returns
 * null and the caller falls back to the soft booking.
 *
 * The returned `reservationId` lets the caller clean the hold up if the request
 * insert it belongs to later fails.
 */
async function holdConcreteSlot(
  organizationId: string,
  preferredWindow: string | null | undefined,
  serviceRequestId: string,
): Promise<{
  readonly startUtc: Date;
  readonly endUtc: Date;
  readonly day: string;
  readonly window: string;
  readonly reservationId: string;
} | null> {
  if (!preferredWindow) return null;
  try {
    // Next-business-day onward (skip today — a same-day booking is the
    // after-hours/urgent path, mirroring the chat route's fetchWindowPrompt).
    const today = businessTodayIso(new Date());
    const days = businessDaysFrom(today, 8).filter((d) => d !== today);
    const availability = await getOpenAvailability(organizationId, days);
    const slot = pickBookableSlot(availability, preferredWindow);
    if (!slot) return null; // preferred band full across the range → soft booking
    // Atomically claim a unit of the band. Ceiling = capacity − already-placed
    // bookings (from this same snapshot), so placed + reserved never exceeds
    // capacity. A lost CAS across every ordinal → band full → soft booking.
    const ceiling = reserveCeilingForBand(availability, slot.day, slot.window);
    const reservation = await reserveCapacitySlot({
      organizationId,
      day: slot.day,
      window: slot.window,
      ceiling,
      serviceRequestId,
    });
    if (!reservation) return null; // no unit could be claimed → soft booking
    const { startUtc, endUtc } = arrivalWindowForSlot(slot.day, slot.window);
    return {
      startUtc,
      endUtc,
      day: slot.day,
      window: slot.window,
      reservationId: reservation.id,
    };
  } catch (holdError: unknown) {
    logger.error(
      { error: holdError, organizationId },
      "Confirm-time capacity hold failed — falling back to soft booking",
    );
    return null;
  }
}

export type SubmitSessionResult =
  | {
      readonly ok: true;
      readonly referenceNumber: string;
      readonly serviceRequestId: string;
      // The CONCRETE arrival window this submission actually RESERVED (via the
      // confirm-time capacity hold), or null on a soft booking. The invariant
      // both channels rely on: a non-null value here means a real unit of
      // capacity was claimed, so it's safe to promise the customer this window.
      // Null → keep soft "we'll confirm your time" language.
      readonly heldWindow: {
        readonly day: string;
        readonly window: string;
        readonly startUtc: string;
        readonly endUtc: string;
      } | null;
    }
  | { readonly ok: false; readonly reason: "do_not_service" | "insert_failed" };

export async function submitSessionServiceRequest(params: {
  readonly organizationId: string;
  readonly sessionId: string;
  readonly data: ServiceRequestData;
  readonly ipAddress: string;
}): Promise<SubmitSessionResult> {
  const { organizationId, sessionId, data, ipAddress } = params;

  // Resolve (or atomically create) the canonical CRM customer for this
  // contact BEFORE the batch. upsertCustomerByContact dedupes via a unique
  // blind-index constraint, so two concurrent submits for the same
  // email/phone converge on one customer id instead of creating duplicates.
  const customerId = await upsertCustomerByContact(organizationId, {
    name: data.customerName,
    email: data.customerEmail,
    phone: data.customerPhone,
    address: data.address,
  });

  // ServiceTitan "Do Not Service" guard: if this customer is flagged, refuse
  // to create the request — the caller routes the customer to a human.
  const [flagRow] = await db
    .select({ doNotService: customers.doNotService })
    .from(customers)
    .where(
      and(
        eq(customers.id, customerId),
        eq(customers.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (flagRow?.doNotService) {
    logger.warn(
      { sessionId, customerId },
      "Submission blocked: customer flagged do_not_service",
    );
    return { ok: false, reason: "do_not_service" };
  }

  const referenceNumber = generateReferenceNumber();
  // Pre-generate the service request id so the audit log can reference it
  // within the same atomic batch (no read-back needed).
  const serviceRequestId = randomUUID();

  // After-hours: compute the flag once at submit time from the org's
  // configured window (its local clock), so dispatch + the dashboard read it
  // off the row. Best-effort config read — fall back to the default window.
  const [settingsRow] = await db
    .select({ afterHoursConfig: organizationSettings.afterHoursConfig })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  const afterHoursConfig = resolveAfterHoursConfig(
    settingsRow?.afterHoursConfig ?? null,
  );

  const heldSlot = await holdConcreteSlot(
    organizationId,
    data.preferredWindow,
    serviceRequestId,
  );

  // The after-hours FLAG must reflect WHEN THE TECHNICIAN GOES OUT, not when
  // the customer happens to confirm. When we hold a concrete arrival window,
  // derive the flag from that instant; otherwise fall back to the submit-time
  // clock. No dollar surcharge is stored — the actual charge depends on the
  // work the team performs.
  const feeInstant = heldSlot?.startUtc ?? new Date();
  const afterHours = isAfterHours(feeInstant, afterHoursConfig);

  // The neon-http driver does not support interactive `db.transaction()`, so
  // the service-request insert, session-status update, and audit-log insert
  // are issued via `db.batch`, which neon executes as a single atomic
  // (non-interactive) transaction.
  // Bridge intake SMS consent into the consent gate: a customer who declined
  // (or granted) SMS at intake must have it reflected in communicationPreferences
  // — checkSendAllowed reads ONLY that table, so writing it here (atomically with
  // the request, in the same batch) is what actually enforces the opt-out.
  const consentUpsert =
    typeof data.smsConsent === "boolean"
      ? db
          .insert(communicationPreferences)
          .values({
            organizationId,
            customerId,
            smsEnabled: data.smsConsent,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [
              communicationPreferences.organizationId,
              communicationPreferences.customerId,
            ],
            set: { smsEnabled: data.smsConsent, updatedAt: new Date() },
          })
      : null;

  const requestInsert = db
      .insert(serviceRequests)
      .values({
        id: serviceRequestId,
        organizationId,
        sessionId,
        customerId,
        status: "pending",
        issueType: data.issueType,
        // ServiceTitan-style work classification derived from the symptom.
        jobType: jobTypeForIssue(data.issueType),
        urgency: data.urgency,
        description: data.description,
        customerNameEncrypted: data.customerName
          ? encrypt(data.customerName)
          : null,
        customerPhoneEncrypted: data.customerPhone
          ? encrypt(data.customerPhone)
          : null,
        customerEmailEncrypted: data.customerEmail
          ? encrypt(data.customerEmail)
          : null,
        addressEncrypted: encrypt(data.address),
        referenceNumber,
        // ── Comprehensive intake fields ──
        // Operational dispatch details, stored plainly (unlike the encrypted
        // name/phone/email/address above). NOTE: accessNotes is customer-
        // entered and may contain a gate code — operationally sensitive but
        // not identifying PII; accepted as plaintext for now since dispatchers
        // must read it. Length-capped at the schema boundary.
        systemType: data.systemType ?? null,
        equipmentBrand: data.equipmentBrand ?? null,
        equipmentAgeBand: data.equipmentAgeBand ?? null,
        propertyType: data.propertyType ?? null,
        ownerOccupant: data.ownerOccupant ?? null,
        underWarranty: data.underWarranty ?? null,
        accessNotes: data.accessNotes ?? null,
        systemDownStatus: data.systemDownStatus ?? null,
        problemDuration: data.problemDuration ?? null,
        vulnerableOccupants: data.vulnerableOccupants ?? null,
        preferredWindow: data.preferredWindow ?? null,
        // Concrete arrival window when a confirm-time capacity hold succeeded:
        // turns the soft preference into a real booked band that consumes
        // capacity. NULL → soft booking, a dispatcher assigns the window later.
        arrivalWindowStart: heldSlot?.startUtc ?? null,
        arrivalWindowEnd: heldSlot?.endUtc ?? null,
        contactPreference: data.contactPreference ?? null,
        smsConsent: data.smsConsent ?? null,
        leadSource: data.leadSource ?? null,
        isAfterHours: afterHours,
      })
      .returning({ id: serviceRequests.id });

  const sessionUpdate = db
    .update(customerSessions)
    .set({ status: "submitted", updatedAt: new Date() })
    // Scope by (id, org) — defense in depth, matching escalate-service.ts.
    .where(
      and(
        eq(customerSessions.id, sessionId),
        eq(customerSessions.organizationId, organizationId),
      ),
    );

  const auditInsert = db.insert(auditLog).values({
    organizationId,
    actorType: "ai",
    sessionId,
    action: "service_request_created",
    entity: "service_requests",
    entityId: serviceRequestId,
    ipAddress,
  });

  // The neon-http batch is atomic: request + session + audit (+ consent when the
  // customer expressed an SMS preference) all commit together or not at all.
  // If it THROWS (a documented live failure mode here — see the
  // migrations-not-run-on-deploy note), nothing persisted, so the capacity hold
  // we claimed for this request must be released or it squats a future slot until
  // that day passes. Release on BOTH the throw path (here) and the empty-return
  // path (below).
  let batchResult;
  try {
    batchResult = consentUpsert
      ? await db.batch([requestInsert, sessionUpdate, auditInsert, consentUpsert])
      : await db.batch([requestInsert, sessionUpdate, auditInsert]);
  } catch (batchError: unknown) {
    if (heldSlot) {
      await releaseReservationById(organizationId, heldSlot.reservationId);
    }
    logger.error(
      { error: batchError, sessionId },
      "Booking batch failed after the capacity hold — released the reservation",
    );
    return { ok: false, reason: "insert_failed" };
  }

  const insertedRequests = batchResult[0];
  const serviceRequest = insertedRequests[0];
  if (!serviceRequest) {
    // The request never persisted — release the capacity hold we claimed for it
    // so the orphaned reservation doesn't squat a slot forever (it's linked to a
    // request id that will never exist). Best-effort.
    if (heldSlot) {
      await releaseReservationById(organizationId, heldSlot.reservationId);
    }
    return { ok: false, reason: "insert_failed" };
  }

  // Criterion-4 eventing: the request's initial status. actorType=ai — this is
  // the AI intake/voice path that produced the booking.
  await recordStatusEvent({
    organizationId,
    serviceRequestId: serviceRequest.id,
    fromStatus: null,
    toStatus: "pending",
    actorType: "ai",
  });

  // Push this confirmed booking into FSM integrations (HCP + Fieldpulse) as
  // JOBS in the BACKGROUND — after() so the response isn't blocked, and
  // degrade-safe so a not-connected org (or an integration hiccup) never
  // affects the booking we just persisted. Each pushJob* function owns the
  // customer sync (mirrors the customer to the FSM first, then creates/updates
  // the job) which keeps it idempotent.
  after(() => pushJobToHcp(organizationId, serviceRequest.id));
  after(() => pushJobToFieldpulse(organizationId, serviceRequest.id));

  // Customer-thread eventing (Probook v3): record the booking on the customer's
  // thread for cross-channel recognition. Best-effort (appendEvent never throws)
  // and additive — guarded on a resolved customerId since the thread is keyed by
  // it. The fields come from in-scope values (the returned row carries only id).
  if (customerId) {
    after(() =>
      appendEvent(organizationId, customerId, {
        kind: "booking",
        labelKey: "booked",
        refId: serviceRequest.id,
        jobType: jobTypeForIssue(data.issueType),
        window: data.preferredWindow ?? null,
        channel: "web",
      }),
    );
  }

  // Cache the job's coordinates for the dispatch map + travel-aware dispatch.
  // Geocode the plaintext service address ONCE (Photon), store it on a customer
  // location, and link it to this request via location_id. BACKGROUND (after())
  // so it never adds latency to the booking, and fully degrade-safe — a geocode
  // miss or db hiccup leaves location_id null and the map falls back to on-demand
  // geocoding, exactly as today.
  // Guard on customerId (matching the sibling appendEvent call) — a falsy id would
  // just be caught + logged in the helper, but skipping avoids the wasted Photon
  // call + noisy log.
  if (customerId) {
    after(() =>
      persistJobLocation({
        organizationId,
        customerId,
        serviceRequestId: serviceRequest.id,
        address: data.address,
      }),
    );
  }

  // Stage 2: when we held a CONCRETE window, auto-assign a technician in the
  // background (placeAndAssignRequest runs a conflict check — too slow for the
  // latency-bound voice/chat turn, so it runs in after()). A booking thus lands
  // fully dispatched (window + tech), not in the unassigned pile. Degrade-safe:
  // if nobody fits, the soft-held window stands for a dispatcher.
  if (heldSlot) {
    after(async () => {
      try {
        // Dynamic import keeps scheduling-queries (and its request-status /
        // schema-enum chain) off the module-load path — only loaded when a
        // booking actually runs.
        const { autoAssignBookedRequest } = await import(
          "@/lib/admin/scheduling-queries"
        );
        const result = await autoAssignBookedRequest(
          organizationId,
          serviceRequest.id,
          {
            start: heldSlot.startUtc,
            end: heldSlot.endUtc,
            isoDay: heldSlot.day,
            window: heldSlot.window as ArrivalWindow,
          },
        );
        if (!result.assigned) {
          logger.info(
            { serviceRequestId: serviceRequest.id },
            "Auto-assign found no available tech — left soft-held for dispatcher",
          );
        }
      } catch (assignErr) {
        logger.error(
          { error: assignErr, serviceRequestId: serviceRequest.id },
          "Auto-assign failed (non-fatal) — soft-held window stands",
        );
      }
    });
  }

  // Stage 3: AI summary + outcome for this (now booked) conversation.
  after(() =>
    summarizeAndClassifySession({
      organizationId,
      sessionId,
      definiteOutcome: "booked",
    }),
  );

  // Record the customer's equipment from the intake (ServiceTitan asset
  // history), best-effort: a failure here must not fail the submission.
  const built = buildEquipmentFromIntake(
    {
      systemType: data.systemType,
      equipmentBrand: data.equipmentBrand,
      equipmentAgeBand: data.equipmentAgeBand,
    },
    new Date(),
  );
  if (built) {
    try {
      await recordCustomerEquipment(organizationId, customerId, built);
    } catch (equipErr) {
      logger.error(
        { error: equipErr, sessionId, customerId },
        "Failed to record customer equipment from intake (non-fatal)",
      );
    }
  }

  logger.info({ sessionId, referenceNumber }, "Service request submitted");

  return {
    ok: true,
    referenceNumber,
    serviceRequestId: serviceRequest.id,
    // Surface the concretely-held window (null on soft booking). Dates → ISO so
    // the result crosses the channel boundary as plain JSON. This is the ONLY
    // window either channel may promise — it exists iff a capacity unit was
    // actually reserved above.
    heldWindow: heldSlot
      ? {
          day: heldSlot.day,
          window: heldSlot.window,
          startUtc: heldSlot.startUtc.toISOString(),
          endUtc: heldSlot.endUtc.toISOString(),
        }
      : null,
  };
}
