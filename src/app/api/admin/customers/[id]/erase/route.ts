/**
 * GET/POST /api/admin/customers/[id]/erase — GDPR right-to-erasure.
 *
 * GET returns the sibling disclosure for the erase confirmation (SPEC §5.1):
 * other rows in the org sharing the target's email or phone hash, so the
 * operator can see the contact appears on N rows before confirming. It is
 * read-only and never erases anything — auto-fan-out is explicitly forbidden,
 * since a shared hash usually means a different data subject, not a repeat.
 *
 * POST is terminal + irreversible: scrubs all of the customer's PII and nulls
 * the blind indexes (so the contact can never be re-resolved to this row),
 * while KEEPING the de-identified financial history, and stays strictly
 * per-row (siblings are never auto-erased). Both are super_admin only, in the
 * acting admin's own org, and never the public demo account (defense-in-depth
 * on top of the role gate). Tenant-scoped and audited (counts only, no PII);
 * POST is additionally rate-limited as a mutation.
 */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { isSuperAdmin, isDemoAccount } from "@/lib/auth/authz";
import { anonymizeCustomer, listContactSiblings } from "@/lib/admin/erasure-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (isDemoAccount(session)) {
      return errorResponse(
        "Erasing customer data is disabled for the demo account",
        "DEMO_RESTRICTED",
        403,
      );
    }
    // Same tier as the erase itself: the list discloses other customers' names.
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid customer ID format", "INVALID_ID", 400);
    }

    const siblings = await listContactSiblings(session.organizationId, id);
    return successResponse({ siblings });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list erasure contact siblings");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    // Defense-in-depth: block the public portfolio demo account outright, even
    // if it somehow held super_admin — today it's blocked only incidentally
    // because the seeded demo role is "admin" (mirrors send-reminder/route.ts
    // and conversations/[id]/message/route.ts).
    if (isDemoAccount(session)) {
      return errorResponse(
        "Erasing customer data is disabled for the demo account",
        "DEMO_RESTRICTED",
        403,
      );
    }
    // Irreversible PII destruction is owner-tier only — aligns with the export
    // routes. (Also keeps the public demo admin from wiping real customers.)
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `admin:customer-erase:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid customer ID format", "INVALID_ID", 400);
    }

    const ipAddress = clientIp(request);

    const erased = await anonymizeCustomer(session.organizationId, id);
    if (!erased) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    // Record the human actor + ip (anonymizeCustomer's own audit row captures
    // the system action with counts; this one attributes it to the admin).
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "customer_erased",
      entity: "customers",
      entityId: id,
      ipAddress,
    });

    return successResponse({ ok: true });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to erase customer");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
