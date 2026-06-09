import { NextRequest, after } from "next/server";
import { and, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  customerSessions,
  serviceRequests,
  auditLog,
  customers,
  organizationSettings,
} from "@/lib/db/schema";
import {
  resolveAfterHoursConfig,
  isAfterHours,
} from "@/lib/admin/after-hours";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { isSameOriginRequest, hasJsonContentType } from "@/lib/session-csrf";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { encrypt } from "@/lib/crypto";
import {
  transition,
  isTerminalState,
  type SessionState,
} from "@/lib/ai/state-machine";
import {
  serviceRequestSchema,
  jobTypeForIssue,
  type ServiceRequestData,
} from "@/lib/ai/extraction-schema";
import { parseKnownSlots, stripSkipSentinels } from "@/lib/ai/chat-slots";
import { upsertCustomerByContact } from "@/lib/admin/crm-queries";
import {
  getOpenAvailability,
  businessDaysFrom,
  businessTodayIso,
} from "@/lib/admin/availability-queries";
import {
  pickBookableSlot,
  arrivalWindowForSlot,
} from "@/lib/admin/capacity-hold";
import { pushJobToHcp } from "@/lib/integrations/housecall-pro/job-sync";
import { recordCustomerEquipment } from "@/lib/admin/crm-equipment-queries";
import { buildEquipmentFromIntake } from "@/lib/admin/equipment-from-intake";
import { logger } from "@/lib/logger";

function generateReferenceNumber(): string {
  // Format: HVAC-XXXXXXXX (8 random hex chars)
  return `HVAC-${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * Confirm-time capacity hold (calendar-robustness stages 2 + 3).
 *
 * At chat time the bot offered windows from REAL availability, but the customer
 * may have sat on the confirm screen while other bookings filled the band. This
 * RE-VERIFIES against current availability right before the write and, when the
 * preferred band still has an opening, turns the soft `preferredWindow` label
 * into a CONCRETE arrival window — so the booking actually consumes capacity that
 * the NEXT customer's `getOpenAvailability` will see (the previous behavior left
 * arrivalWindow NULL, so nothing was ever consumed and two customers could claim
 * the same band indefinitely).
 *
 * This SHRINKS the race to the few ms between this re-read and the insert (we
 * cannot SELECT ... FOR UPDATE on neon-http). It NEVER blocks the lead: any
 * failure, or a fully-booked preferred band, returns null and the caller falls
 * back to the soft booking (preferredWindow label only, dispatcher assigns).
 *
 * Returns the concrete arrival window + the resolved {day, window}, or null.
 */
async function holdConcreteSlot(
  organizationId: string,
  preferredWindow: string | null | undefined,
): Promise<{
  readonly startUtc: Date;
  readonly endUtc: Date;
  readonly day: string;
  readonly window: string;
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
    const { startUtc, endUtc } = arrivalWindowForSlot(slot.day, slot.window);
    return { startUtc, endUtc, day: slot.day, window: slot.window };
  } catch (holdError: unknown) {
    logger.error(
      { error: holdError, organizationId },
      "Confirm-time capacity hold failed — falling back to soft booking",
    );
    return null;
  }
}

export async function POST(request: NextRequest) {
  const ip = request.headers.get("x-forwarded-for") ?? "unknown";
  const rateCheck = slidingWindow(
    `session:action:${ip}`,
    RATE_LIMITS.sessionAction.maxRequests,
    RATE_LIMITS.sessionAction.windowMs,
  );

  if (!rateCheck.allowed) {
    return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
  }

  // CSRF: session cookie is SameSite=None — only same-origin callers may submit.
  if (!isSameOriginRequest(request)) {
    return errorResponse("Cross-origin request rejected", "FORBIDDEN_ORIGIN", 403);
  }
  // Defense-in-depth: block the no-preflight text/plain form-POST vector.
  if (!hasJsonContentType(request)) {
    return errorResponse("Expected application/json", "UNSUPPORTED_MEDIA_TYPE", 415);
  }

  try {
    const token = await getSessionToken();
    if (!token) {
      return errorResponse("No session found", "NO_SESSION", 401);
    }

    const [session] = await db
      .select()
      .from(customerSessions)
      .where(eq(customerSessions.token, token))
      .limit(1);

    if (!session) {
      return errorResponse("Session not found", "SESSION_NOT_FOUND", 404);
    }

    // Everything written below is scoped to the session's own organization.
    const organizationId = session.organizationId;

    // Parse and validate the service request data from request body
    const body: unknown = await request.json();
    const parsed = serviceRequestSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid service request data",
        "VALIDATION_FAILED",
        400,
      );
    }

    // Enrichment fields are gathered during the conversation and live in the
    // session metadata. The browser confirm payload may only carry the core
    // fields, so we read the enrichment SERVER-SIDE from the session's own
    // metadata (the source of truth) — the client cannot drop it. Any field the
    // client did send takes precedence (a last-second edit on the review card).
    const sessionExtras = stripSkipSentinels(
      parseKnownSlots(session.metadata).extras ?? {},
    );
    const merged = { ...sessionExtras, ...parsed.data } as ServiceRequestData;

    // Vulnerable-occupant urgency bump: an elderly/infant/medically-fragile
    // household with a non-emergency failure is bumped one tier (low→medium→
    // high), capped below "emergency" (true emergencies come from the safety
    // path, not this heuristic). Mirrors how a dispatcher would prioritize.
    const URGENCY_BUMP: Record<string, "low" | "medium" | "high"> = {
      low: "medium",
      medium: "high",
      high: "high",
    };
    const data: ServiceRequestData =
      merged.vulnerableOccupants === true && merged.urgency !== "emergency"
        ? { ...merged, urgency: URGENCY_BUMP[merged.urgency] }
        : merged;

    // Transition to 'confirmed'. The payload already passed
    // serviceRequestSchema (issue/urgency/address/phone/email/description all
    // present and valid), so this IS a complete, submittable request — the only
    // thing that should ever block it is a genuinely terminal session
    // (already submitted, escalated to a human, or abandoned).
    //
    // Robustness fix: 'confirmed' is only reachable from 'extracting', but a
    // session can legitimately be sitting in 'chatting' when the customer taps
    // Confirm & Submit — e.g. an LLM-driven turn declared the intake complete in
    // prose while the server-side completeness flag lagged, so the status never
    // advanced to 'extracting'. Rather than reject a complete request (the
    // customer sees "didn't work"), we PROMOTE chatting -> extracting first, then
    // confirm. Terminal states still hard-block.
    if (isTerminalState(session.status) || session.status === "submitted") {
      return errorResponse(
        `This request can no longer be submitted (session is '${session.status}'). Please start a new request or call our office.`,
        "INVALID_STATE_TRANSITION",
        409,
      );
    }

    // Promote chatting -> extracting so the confirmed transition is valid. (A
    // session already in 'extracting' or 'confirmed' skips this no-op.)
    const startState: SessionState =
      session.status === "chatting" ? "extracting" : session.status;

    const confirmResult = transition(startState, "confirmed");
    if (!confirmResult.success) {
      logger.error(
        { sessionId: session.id, status: session.status, startState },
        "Confirm transition unexpectedly failed for a complete request",
      );
      return errorResponse(
        "We couldn't submit your request just now. Please try again, or call our office and we'll take it directly.",
        "INVALID_STATE_TRANSITION",
        409,
      );
    }

    const submitResult = transition("confirmed", "submitted");
    if (!submitResult.success) {
      return errorResponse(
        "We couldn't submit your request just now. Please try again, or call our office and we'll take it directly.",
        "INVALID_STATE_TRANSITION",
        409,
      );
    }

    // Resolve (or atomically create) the canonical CRM customer for this
    // contact BEFORE the batch. upsertCustomerByContact dedupes via a unique
    // blind-index constraint, so two concurrent submits for the same
    // email/phone converge on one customer id instead of creating duplicates.
    // Doing it up front (not inside the batch) means the service request below
    // always references a customer row that already exists — no dangling FK.
    const customerId = await upsertCustomerByContact(organizationId, {
      name: data.customerName,
      email: data.customerEmail,
      phone: data.customerPhone,
      address: data.address,
    });

    // ServiceTitan "Do Not Service" guard: if this customer is flagged, refuse
    // to create the request and route them to a human instead of silently
    // booking. Tenant-scoped read by customer id.
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
        { sessionId: session.id, customerId },
        "Confirm blocked: customer flagged do_not_service",
      );
      return errorResponse(
        "We're unable to book this online. Please call our office so we can help you directly.",
        "DO_NOT_SERVICE",
        409,
      );
    }

    // Encrypt PII fields individually before insert per D-05
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

    // Stages 2+3: re-verify the customer's preferred window against CURRENT
    // availability and, if it's still open, reserve a concrete arrival window so
    // the booking actually consumes calendar capacity. Best-effort: null → soft
    // booking (preferredWindow label only), never blocks the lead.
    const heldSlot = await holdConcreteSlot(
      organizationId,
      data.preferredWindow,
    );

    // Stage 4: the after-hours FLAG must reflect WHEN THE TECHNICIAN GOES OUT,
    // not when the customer happens to confirm. When we hold a concrete arrival
    // window, derive the flag from that instant — so a tomorrow-morning booking
    // confirmed at 11pm is NOT flagged after-hours (aligning the stored flag
    // with the bot's spoken "no after-hours charge for a business-hours
    // visit"). Only when no slot is held (soft booking, time genuinely unknown)
    // do we fall back to the confirm-time clock. No dollar surcharge is stored —
    // the actual charge depends on the work the team performs.
    const feeInstant = heldSlot?.startUtc ?? new Date();
    const afterHours = isAfterHours(feeInstant, afterHoursConfig);

    // The neon-http driver does not support interactive `db.transaction()`
    // (it throws "No transactions support in neon-http driver"), so the
    // service-request insert, session-status update, and audit-log insert are
    // issued via `db.batch`, which neon executes as a single atomic
    // (non-interactive) transaction.
    const [insertedRequests] = await db.batch([
      db
        .insert(serviceRequests)
        .values({
          id: serviceRequestId,
          organizationId: organizationId,
          sessionId: session.id,
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
          // Concrete arrival window when a confirm-time capacity hold succeeded
          // (stages 2+3): turns the soft preference into a real booked band that
          // consumes capacity for the next customer. NULL → soft booking, a
          // dispatcher assigns the window later.
          arrivalWindowStart: heldSlot?.startUtc ?? null,
          arrivalWindowEnd: heldSlot?.endUtc ?? null,
          contactPreference: data.contactPreference ?? null,
          smsConsent: data.smsConsent ?? null,
          leadSource: data.leadSource ?? null,
          isAfterHours: afterHours,
        })
        .returning({ id: serviceRequests.id }),
      db
        .update(customerSessions)
        .set({ status: "submitted", updatedAt: new Date() })
        // Scope by (id, org) — defense in depth, matching escalate-service.ts.
        .where(
          and(
            eq(customerSessions.id, session.id),
            eq(customerSessions.organizationId, organizationId),
          ),
        ),
      db.insert(auditLog).values({
        organizationId: organizationId,
        sessionId: session.id,
        action: "service_request_created",
        entity: "service_requests",
        entityId: serviceRequestId,
        ipAddress: ip,
      }),
    ]);

    const serviceRequest = insertedRequests[0];

    if (!serviceRequest) {
      return errorResponse(
        "Failed to create service request",
        "SERVICE_REQUEST_CREATE_FAILED",
        500,
      );
    }

    // Push this confirmed booking into Housecall Pro as a JOB in the BACKGROUND
    // — after() so the response isn't blocked, and degrade-safe so a not-
    // connected org (or an HCP hiccup) never affects the booking we just
    // persisted. pushJobToHcp ensures the customer is mirrored to HCP FIRST
    // (Stage 2 — syncCustomerToHcp, sequentially within this one call), then
    // creates the HCP job (or updates it if one already exists). We do NOT also
    // fire syncCustomerToHcp separately here: two concurrent after() callbacks
    // syncing the same brand-new customer would both see hcp_customer_id = null
    // and both create a duplicate HCP customer (the isNull DB guard only
    // protects the mapping write, not the upstream HCP create). Letting
    // pushJobToHcp own the customer sync keeps it idempotent. (At confirm time
    // the request has no arrival window yet, so the job is created unscheduled;
    // dispatch's reschedule/assign updates it.)
    after(() => pushJobToHcp(organizationId, serviceRequest.id));

    // Record the customer's equipment from the intake (ServiceTitan asset
    // history), best-effort: a failure here must not fail the submission, which
    // already succeeded. De-duped — we don't add a second unit of the same type
    // for a returning customer; if a brand/install date is now known we enrich
    // the existing row instead.
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
          { error: equipErr, sessionId: session.id, customerId },
          "Failed to record customer equipment from intake (non-fatal)",
        );
      }
    }

    logger.info(
      { sessionId: session.id, referenceNumber },
      "Service request submitted",
    );

    return successResponse(
      {
        referenceNumber,
        serviceRequestId: serviceRequest.id,
        status: "submitted" as const,
      },
      201,
    );
  } catch (error) {
    logger.error({ error }, "Failed to confirm session");
    return errorResponse(
      "Failed to confirm and submit",
      "CONFIRM_FAILED",
      500,
    );
  }
}
