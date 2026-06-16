/**
 * Stage 4 — staffed inbox: a human CSR sends a reply into a conversation.
 *
 * POST inserts an agent message, sends it over the channel (SMS today), flips the
 * session to mode='human' (so the bot stops auto-replying — see sms/incoming),
 * and audits it. Tenant-scoped + consent-gated (a do-not-contact / channel-off
 * customer is never messaged, even from the inbox).
 */
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { customerSessions, messages } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { sendSms } from "@/lib/communication/twilio-adapter";
import { checkSendAllowed } from "@/lib/communication/consent";
import { logAudit } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";

const bodySchema = z.object({ message: z.string().trim().min(1).max(1600) });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const rate = slidingWindow(
      `admin:conv-msg:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id: sessionId } = await params;
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Message is required", "INVALID_INPUT", 400);
    }

    const [conv] = await db
      .select({
        id: customerSessions.id,
        token: customerSessions.token,
        channel: customerSessions.channel,
        customerId: customerSessions.customerId,
      })
      .from(customerSessions)
      .where(
        withTenant(customerSessions, session.organizationId, eq(customerSessions.id, sessionId)),
      )
      .limit(1);

    if (!conv) {
      return errorResponse("Conversation not found", "NOT_FOUND", 404);
    }

    // SMS is the only outbound channel today. The session token for a phone
    // thread is "sms:<E.164>"; derive the recipient from it.
    const recipient = conv.token.startsWith("sms:")
      ? conv.token.slice("sms:".length)
      : "";
    // A retired token looks like "sms:<phone>:<sessionId>" (closed thread) — its
    // sliced value contains a ':'. Reject anything that isn't a clean number.
    if (conv.channel !== "sms" || recipient.length === 0 || recipient.includes(":")) {
      return errorResponse(
        "Replying is only supported for active SMS conversations",
        "UNSUPPORTED_CHANNEL",
        400,
      );
    }

    // Consent: do-not-contact / channel-off customers are never messaged. Use
    // the "escalation" trigger semantics — a human-driven reply checks
    // doNotContact + channel only (no quiet-hours/type gating on a live thread).
    const decision = await checkSendAllowed({
      organizationId: session.organizationId,
      customerId: conv.customerId,
      channel: "sms",
      triggerType: "escalation",
    });
    if (!decision.allowed) {
      return errorResponse(
        `Cannot message this customer: ${decision.reason}`,
        "CONSENT_BLOCKED",
        409,
      );
    }

    await sendSms({ to: recipient, body: parsed.data.message });

    // Persist the agent message + flip to human takeover so the bot goes quiet.
    await db.insert(messages).values({
      organizationId: session.organizationId,
      sessionId: conv.id,
      role: "assistant",
      content: parsed.data.message,
    });
    await db
      .update(customerSessions)
      .set({ mode: "human", updatedAt: new Date() })
      .where(
        withTenant(customerSessions, session.organizationId, eq(customerSessions.id, conv.id)),
      );

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      actorType: "human",
      action: "conversation_reply_sent",
      entity: "customer_sessions",
      entityId: conv.id,
    });

    logger.info({ sessionId: conv.id, adminId: session.userId }, "Agent SMS reply sent");
    return successResponse({ sent: true, mode: "human" });
  } catch (error) {
    logger.error({ error }, "Failed to send conversation reply");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
