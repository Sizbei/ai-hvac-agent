import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import {
  customerSessions,
  serviceRequests,
  auditLog,
  customers,
} from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { encrypt } from "@/lib/crypto";
import { transition } from "@/lib/ai/state-machine";
import { serviceRequestSchema } from "@/lib/ai/extraction-schema";
import { findCustomerIdByContact } from "@/lib/admin/crm-queries";
import { logger } from "@/lib/logger";

const DEMO_ORG_ID = "00000000-0000-0000-0000-000000000001";

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

  try {
    const token = await getSessionToken();
    if (!token) {
      return errorResponse("No session found", "NO_SESSION", 401);
    }

    const [session] = await db
      .select()
      .from(customerSessions)
      .where(
        withTenant(
          customerSessions,
          DEMO_ORG_ID,
          eq(customerSessions.token, token),
        ),
      );

    if (!session) {
      return errorResponse("Session not found", "SESSION_NOT_FOUND", 404);
    }

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

    // Resolve the CRM customer for this request. The lookup is read-only; the
    // customer row itself is upserted inside the atomic batch below so a failed
    // submit can never leave an orphaned customer record behind.
    const existingCustomerId = await findCustomerIdByContact(DEMO_ORG_ID, {
      email: parsed.data.customerEmail,
      phone: parsed.data.customerPhone,
    });
    const customerId = existingCustomerId ?? randomUUID();

    // Encrypt PII fields individually before insert per D-05
    const referenceNumber = generateReferenceNumber();
    // Pre-generate the service request id so the audit log can reference it
    // within the same atomic batch (no read-back needed).
    const serviceRequestId = randomUUID();

    // The neon-http driver does not support interactive `db.transaction()`
    // (it throws "No transactions support in neon-http driver"), so the
    // customer upsert, service-request insert, session-status update, and
    // audit-log insert are issued via `db.batch`, which neon executes as a
    // single atomic (non-interactive) transaction. The customer upsert runs
    // first so the service request's customerId FK resolves; when the customer
    // already exists (existingCustomerId) onConflictDoNothing leaves it intact.
    const [, insertedRequests] = await db.batch([
      db
        .insert(customers)
        .values({
          id: customerId,
          organizationId: DEMO_ORG_ID,
          nameEncrypted: encrypt(parsed.data.customerName ?? "Unknown"),
          phoneEncrypted: parsed.data.customerPhone
            ? encrypt(parsed.data.customerPhone)
            : null,
          emailEncrypted: parsed.data.customerEmail
            ? encrypt(parsed.data.customerEmail)
            : null,
          addressEncrypted: encrypt(parsed.data.address),
        })
        .onConflictDoNothing(),
      db
        .insert(serviceRequests)
        .values({
          id: serviceRequestId,
          organizationId: DEMO_ORG_ID,
          sessionId: session.id,
          customerId,
          status: "pending",
          issueType: parsed.data.issueType,
          urgency: parsed.data.urgency,
          description: parsed.data.description,
          customerNameEncrypted: parsed.data.customerName
            ? encrypt(parsed.data.customerName)
            : null,
          customerPhoneEncrypted: parsed.data.customerPhone
            ? encrypt(parsed.data.customerPhone)
            : null,
          customerEmailEncrypted: parsed.data.customerEmail
            ? encrypt(parsed.data.customerEmail)
            : null,
          addressEncrypted: encrypt(parsed.data.address),
          referenceNumber,
        })
        .returning({ id: serviceRequests.id }),
      db
        .update(customerSessions)
        .set({ status: "submitted", updatedAt: new Date() })
        .where(eq(customerSessions.id, session.id)),
      db.insert(auditLog).values({
        organizationId: DEMO_ORG_ID,
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
