import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  customerSessions,
  serviceRequests,
  auditLog,
  customers,
} from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { isSameOriginRequest, hasJsonContentType } from "@/lib/session-csrf";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { encrypt } from "@/lib/crypto";
import { transition } from "@/lib/ai/state-machine";
import {
  serviceRequestSchema,
  jobTypeForIssue,
  type ServiceRequestData,
} from "@/lib/ai/extraction-schema";
import { parseKnownSlots, stripSkipSentinels } from "@/lib/ai/chat-slots";
import { upsertCustomerByContact } from "@/lib/admin/crm-queries";
import { recordCustomerEquipment } from "@/lib/admin/crm-equipment-queries";
import { buildEquipmentFromIntake } from "@/lib/admin/equipment-from-intake";
import { logger } from "@/lib/logger";

function generateReferenceNumber(): string {
  // Format: HVAC-XXXXXXXX (8 random hex chars)
  return `HVAC-${randomBytes(4).toString("hex").toUpperCase()}`;
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

    // Transition: current state -> confirmed -> submitted
    const confirmResult = transition(session.status, "confirmed");
    if (!confirmResult.success) {
      return errorResponse(
        `Cannot confirm from state '${session.status}'`,
        "INVALID_STATE_TRANSITION",
        409,
      );
    }

    const submitResult = transition("confirmed", "submitted");
    if (!submitResult.success) {
      return errorResponse(
        "Cannot submit after confirm",
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
          contactPreference: data.contactPreference ?? null,
          smsConsent: data.smsConsent ?? null,
          leadSource: data.leadSource ?? null,
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
