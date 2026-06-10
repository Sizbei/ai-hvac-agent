import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import {
  listCustomFaqs,
  createCustomFaq,
} from "@/lib/admin/org-config-queries";
import { customFaqInputSchema } from "@/lib/admin/org-config-types";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Upper bound on custom FAQs per org — keeps the deterministic matcher's
 * per-message scan bounded and prevents unbounded growth. */
const MAX_CUSTOM_FAQS = 100;

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:faqs-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const faqs = await listCustomFaqs(session.organizationId);
    return successResponse({ faqs });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list custom FAQs");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:faqs-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = customFaqInputSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid FAQ: " + parsed.error.issues[0]?.message,
        "VALIDATION_ERROR",
        400,
      );
    }

    const existing = await listCustomFaqs(session.organizationId);
    if (existing.length >= MAX_CUSTOM_FAQS) {
      return errorResponse(
        `You can have at most ${MAX_CUSTOM_FAQS} custom FAQs.`,
        "LIMIT_REACHED",
        409,
      );
    }

    const faq = await createCustomFaq(session.organizationId, parsed.data);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_custom_faq",
      entity: "custom_faqs",
      entityId: faq.id,
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit FAQ creation");
    });

    return successResponse({ faq }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create custom FAQ");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
