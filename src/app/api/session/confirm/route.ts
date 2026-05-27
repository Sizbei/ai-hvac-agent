import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { customerSessions, serviceRequests, auditLog } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { encrypt } from "@/lib/crypto";
import { transition } from "@/lib/ai/state-machine";
import { serviceRequestSchema } from "@/lib/ai/extraction-schema";
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

    // Encrypt PII fields individually before insert per D-05
    const referenceNumber = generateReferenceNumber();

    const [serviceRequest] = await db
      .insert(serviceRequests)
      .values({
        organizationId: DEMO_ORG_ID,
        sessionId: session.id,
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
      .returning();

    if (!serviceRequest) {
      return errorResponse(
        "Failed to create service request",
        "SERVICE_REQUEST_CREATE_FAILED",
        500,
      );
    }

    // Update session status to submitted
    await db
      .update(customerSessions)
      .set({ status: "submitted", updatedAt: new Date() })
      .where(eq(customerSessions.id, session.id));

    // Audit log
    await db.insert(auditLog).values({
      organizationId: DEMO_ORG_ID,
      sessionId: session.id,
      action: "service_request_created",
      entity: "service_requests",
      entityId: serviceRequest.id,
      ipAddress: ip,
    });

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
