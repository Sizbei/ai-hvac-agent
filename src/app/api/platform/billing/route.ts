/**
 * SaaS-billing API for an org's OWN platform subscription (Stage 10).
 *
 *   GET  /api/platform/billing
 *        -> current plan + status + entitlements for the caller's org
 *   POST /api/platform/billing  { action: "checkout", planId }
 *        -> getBillingProvider().createCheckoutSession -> { url }
 *   POST /api/platform/billing  { action: "portal" }
 *        -> getBillingProvider().createPortalSession -> { url }
 *
 * Gated by getAdminSession THEN (super_admin of the org OR platform admin): a
 * normal admin/technician gets 403. Billing is an account-owner concern, so the
 * org's top-tier operator (super_admin) manages it for their own org; a platform
 * admin may too. The route only ever acts on the SESSION's org — never another.
 *
 * DEGRADE-SAFE: with no STRIPE_SECRET_KEY the mock provider returns placeholder
 * URLs and every path still works (no real charges).
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { isSuperAdmin, isPlatformAdmin } from "@/lib/auth/authz";
import { db } from "@/lib/db";
import { organizations } from "@/lib/db/schema";
import { getBillingProvider } from "@/lib/billing/provider";
import { isOrgActive } from "@/lib/billing/entitlements";
import { getPlan, isValidPlanId } from "@/lib/billing/plans";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import type { AdminSessionPayload } from "@/lib/auth/types";

/** True when the session may view/manage billing for its own org. */
function canManageBilling(session: AdminSessionPayload): boolean {
  return isSuperAdmin(session) || isPlatformAdmin(session);
}

export async function GET(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!canManageBilling(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `platform:billing-get:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const [org] = await db
      .select({
        plan: organizations.plan,
        status: organizations.status,
        currentPeriodEnd: organizations.currentPeriodEnd,
      })
      .from(organizations)
      .where(eq(organizations.id, session.organizationId))
      .limit(1);

    if (!org) {
      return errorResponse("Organization not found", "NOT_FOUND", 404);
    }

    const plan = getPlan(org.plan);

    return successResponse({
      plan: {
        id: plan.id,
        label: plan.label,
        priceCents: plan.priceCents,
        interval: plan.interval,
      },
      status: org.status,
      active: isOrgActive(org),
      currentPeriodEnd: org.currentPeriodEnd?.toISOString() ?? null,
      entitlements: plan.entitlements,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to load billing state");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("checkout"), planId: z.string().min(1).max(64) }),
  z.object({ action: z.literal("portal") }),
]);

export async function POST(request: NextRequest): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!canManageBilling(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `platform:billing-post:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const raw: unknown = await request.json();
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) {
      return errorResponse(
        "A valid action ('checkout' with a planId, or 'portal') is required",
        "VALIDATION_ERROR",
        400,
      );
    }

    const provider = getBillingProvider();
    const origin = request.nextUrl.origin;

    if (parsed.data.action === "checkout") {
      if (!isValidPlanId(parsed.data.planId)) {
        return errorResponse("Unknown plan", "UNKNOWN_PLAN", 400);
      }
      const { url } = await provider.createCheckoutSession({
        orgId: session.organizationId,
        planId: parsed.data.planId,
        successUrl: new URL("/admin/settings/billing?checkout=success", origin).toString(),
        cancelUrl: new URL("/admin/settings/billing?checkout=cancel", origin).toString(),
      });

      await logAudit({
        organizationId: session.organizationId,
        userId: session.userId,
        action: "billing_checkout_started",
        entity: "organization",
        entityId: session.organizationId,
        // Enum/id only — provider name + target plan id, no URLs/PII.
        details: JSON.stringify({ provider: provider.name, planId: parsed.data.planId }),
        ipAddress: request.headers.get("x-forwarded-for") ?? "unknown",
      });

      return successResponse({ url });
    }

    // action === "portal"
    const { url } = await provider.createPortalSession({
      orgId: session.organizationId,
      returnUrl: new URL("/admin/settings/billing", origin).toString(),
    });

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "billing_portal_opened",
      entity: "organization",
      entityId: session.organizationId,
      details: JSON.stringify({ provider: provider.name }),
      ipAddress: request.headers.get("x-forwarded-for") ?? "unknown",
    });

    return successResponse({ url });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to start billing session");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
