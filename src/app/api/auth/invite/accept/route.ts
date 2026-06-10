/**
 * POST /api/auth/invite/accept
 *
 * PUBLIC (pre-authentication) endpoint that consumes a team invite. The token in
 * the request body is the ONLY bearer of authority; the new user's role and org
 * come from the trusted invite row, never from request input. On success for an
 * admin-role invite we mint an admin session and tell the client to go to the
 * dashboard; for a technician invite the account is created but no admin session
 * is issued (technician is not a session role).
 *
 * Hardening: rate-limited per IP; all token failures collapse to a single
 * generic error (no invite/account enumeration); name+password are validated.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { acceptInvite } from "@/lib/admin/invites";
import { createAdminSession } from "@/lib/auth/session";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const acceptSchema = z.object({
  // 64 hex chars (randomBytes(32)). Constrain shape so junk is rejected cheaply.
  token: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
});

/** Best-effort client IP. x-forwarded-for is client-controllable, so we take
 * only the LEFTMOST address (the real client at the edge; appended hops can't
 * shift the rate-limit bucket) and cap the length (45 = longest IPv6). */
function clientIp(request: NextRequest): string {
  const raw = request.headers.get("x-forwarded-for");
  return raw?.split(",")[0]?.trim().slice(0, 45) || "unknown";
}

export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request);
    const rateCheck = slidingWindow(
      `auth:invite-accept:${ip}`,
      RATE_LIMITS.sessionCreate.maxRequests,
      RATE_LIMITS.sessionCreate.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse(
        "Too many attempts. Try again later.",
        "RATE_LIMITED",
        429,
      );
    }

    const body: unknown = await request.json();
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) {
      // Generic: don't reveal whether it was the token shape or the fields.
      return errorResponse(
        "This invitation is no longer valid, or the form was incomplete.",
        "INVALID_INVITE",
        400,
      );
    }

    const { token, name, password } = parsed.data;
    const result = await acceptInvite(token, { name, password });

    if (!result.ok) {
      // Collapse invalid/expired/used/revoked/email_conflict to ONE generic
      // message + status so a probe can't enumerate invites or accounts.
      return errorResponse(
        "This invitation is no longer valid.",
        "INVALID_INVITE",
        400,
      );
    }

    const { accepted } = result;

    // Audit the account creation — a security-relevant event — in the invite's
    // org. The new user is both the entity and (self-)actor; details carry the
    // role enum only (never the email, name, password, or token).
    await logAudit({
      organizationId: accepted.organizationId,
      userId: accepted.userId,
      action: "accept_invite",
      entity: "user",
      entityId: accepted.userId,
      details: JSON.stringify({ role: accepted.role }),
      ipAddress: ip,
    });

    // Admin-role invite → mint the session cookie and send them to the
    // dashboard. Technician invite → account created, but no admin session.
    if (accepted.session) {
      await createAdminSession(accepted.session);
      logger.info(
        { userId: accepted.userId },
        "Invite accepted (admin session created)",
      );
      return successResponse({
        redirectTo: "/admin",
        role: accepted.role,
      });
    }

    logger.info(
      { userId: accepted.userId },
      "Invite accepted (technician account created)",
    );
    return successResponse({
      redirectTo: "/admin/login",
      role: accepted.role,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to accept invite");
    return errorResponse("Could not accept invite", "ACCEPT_FAILED", 500);
  }
}
