/**
 * Platform tenant-provisioning API (Stage 9 v1).
 *
 *   GET  /api/platform/organizations            -> list orgs (platform console)
 *   POST /api/platform/organizations { name, ownerEmail } -> provision a tenant
 *
 * Both are gated by getAdminSession THEN isPlatformAdmin (an env allowlist) — a
 * normal org super_admin gets a 403. This is the cross-org actor; provisioning a
 * tenant is a platform operation, not an in-org one.
 *
 * POST returns the org id + the one-time owner invite URL. The invite token is
 * shown exactly once (never stored); the owner accepts it via the existing,
 * unchanged accept flow and signs in with Google.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { desc } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/authz";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { provisionOrganization } from "@/lib/admin/provisioning";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

export async function GET(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isPlatformAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `platform:orgs-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const rows = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        status: organizations.status,
        createdAt: organizations.createdAt,
      })
      .from(organizations)
      .orderBy(desc(organizations.createdAt));

    return successResponse({
      organizations: rows.map((o) => ({
        id: o.id,
        name: o.name,
        status: o.status,
        createdAt: o.createdAt.toISOString(),
      })),
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list organizations");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

const provisionSchema = z.object({
  name: z.string().trim().min(1).max(200),
  ownerEmail: z.string().email().max(320),
});

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isPlatformAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `platform:orgs-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = provisionSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "A business name and a valid owner email are required",
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await provisionOrganization({
      name: parsed.data.name,
      ownerEmail: parsed.data.ownerEmail,
      createdBy: session.userId,
    });

    if (!result.ok) {
      switch (result.reason) {
        case "invalid_name":
          return errorResponse(
            "The business name must contain letters or numbers",
            "VALIDATION_ERROR",
            400,
          );
        case "slug_conflict":
          return errorResponse(
            "An organization with a similar name already exists",
            "SLUG_CONFLICT",
            409,
          );
        case "owner_email_in_use":
          return errorResponse(
            "That email already belongs to an existing user",
            "OWNER_EMAIL_IN_USE",
            409,
          );
        case "org_limit_reached":
          return errorResponse(
            "The platform has reached its organization limit",
            "ORG_LIMIT_REACHED",
            409,
          );
      }
    }

    const { provisioned } = result;

    // One-time owner accept link, built from the request origin so it works
    // across environments without an env var. The plaintext token is returned
    // exactly once here (never stored).
    const inviteUrl = new URL(
      `/admin/invite/${provisioned.inviteToken}`,
      request.nextUrl.origin,
    ).toString();

    // Audit in the NEW org. Details carry ids/enums ONLY — never ownerEmail
    // (PII). The platform admin who created it is the actor.
    const ipAddress = clientIp(request);
    await logAudit({
      organizationId: provisioned.organizationId,
      userId: session.userId,
      action: "org_provisioned",
      entity: "organization",
      entityId: provisioned.organizationId,
      details: JSON.stringify({
        createdBy: session.userId,
        ownerInviteRole: provisioned.ownerInvite.role,
      }),
      ipAddress,
    });

    return successResponse(
      { organizationId: provisioned.organizationId, inviteUrl },
      201,
    );
  } catch (error: unknown) {
    logger.error({ error }, "Failed to provision organization");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
