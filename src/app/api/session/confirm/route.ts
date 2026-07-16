import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerSessions } from "@/lib/db/schema";
import { successResponse, errorResponse } from "@/lib/api-response";
import { getSessionToken } from "@/lib/session";
import { isSameOriginRequest, hasJsonContentType } from "@/lib/session-csrf";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import {
  transition,
  isTerminalState,
  type SessionState,
} from "@/lib/ai/state-machine";
import {
  serviceRequestSchema,
  type ServiceRequestData,
} from "@/lib/ai/extraction-schema";
import {
  parseKnownSlots,
  stripSkipSentinels,
  SKIP_SENTINEL,
} from "@/lib/ai/chat-slots";
import { submitSessionServiceRequest } from "@/lib/requests/submit-session-request";
import { formatArrivalWindow } from "@/lib/admin/arrival-window";
import { BUSINESS_TIME_ZONE } from "@/lib/admin/calendar-time";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";
export async function POST(request: NextRequest) {
  const ip = clientIp(request);
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
    // A skipped email reaches the client as the skip sentinel (or an empty
    // string after an edit) — normalize both to null so the schema's
    // "real email or null" contract holds.
    if (typeof body === "object" && body !== null && "customerEmail" in body) {
      const rec = body as Record<string, unknown>;
      if (rec.customerEmail === SKIP_SENTINEL || rec.customerEmail === "") {
        rec.customerEmail = null;
      }
    }
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

    // Canonical submission effects (CRM upsert, do-not-service guard,
    // capacity hold, after-hours flag, atomic batch, HCP push, equipment
    // record) live in the shared module so the phone channel's auto-submit
    // and this web confirm can never drift.
    const submitted = await submitSessionServiceRequest({
      organizationId,
      sessionId: session.id,
      data,
      ipAddress: ip,
    });

    if (!submitted.ok) {
      if (submitted.reason === "do_not_service") {
        return errorResponse(
          "We're unable to book this online. Please call our office so we can help you directly.",
          "DO_NOT_SERVICE",
          409,
        );
      }
      return errorResponse(
        "Failed to create service request",
        "SERVICE_REQUEST_CREATE_FAILED",
        500,
      );
    }

    // Surface the CONCRETELY-held arrival window (null on a soft booking) plus a
    // human label so the chat client can tell the customer the exact window we
    // reserved — never a window we didn't. formatArrivalWindow degrades to null
    // on bad/missing bounds, so a label failure can't break the confirmation.
    const arrivalWindow = submitted.heldWindow
      ? {
          ...submitted.heldWindow,
          // Render in the BUSINESS timezone: the held window's band hours are
          // Eastern-anchored (arrivalWindowForSlot), so UTC would tell the
          // customer the wrong hours (an 8 AM ET slot would read as 12 PM).
          label: formatArrivalWindow(
            submitted.heldWindow.startUtc,
            submitted.heldWindow.endUtc,
            BUSINESS_TIME_ZONE,
          ),
        }
      : null;

    return successResponse(
      {
        referenceNumber: submitted.referenceNumber,
        serviceRequestId: submitted.serviceRequestId,
        status: "submitted" as const,
        arrivalWindow,
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
