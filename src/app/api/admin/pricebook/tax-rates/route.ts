import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { listTaxRates, createTaxRate } from "@/lib/admin/pricebook-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { logger } from "@/lib/logger";

const taxSchema = z.object({
  name: z.string().trim().min(1).max(255),
  jurisdiction: z.string().optional(),
  rateBps: z.number().int().min(0).max(10000),
  isDefault: z.boolean().default(false),
});

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:tax-rates-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const taxRates = await listTaxRates(session.organizationId);
    return successResponse({ taxRates });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch tax rates");
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
      `admin:tax-rates-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const parsed = taxSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid tax rate", "VALIDATION_ERROR", 400);
    }

    const id = await createTaxRate(session.organizationId, parsed.data);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_tax_rate",
      entity: "tax_rate",
      entityId: id,
      details: `rateBps=${parsed.data.rateBps};isDefault=${parsed.data.isDefault}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, taxRateId: id },
        "Failed to write audit log for tax rate creation",
      );
    });

    return successResponse({ id }, 201);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return errorResponse(
        "A default tax rate already exists",
        "TAX_RATE_CONFLICT",
        409,
      );
    }
    logger.error({ error }, "Failed to create tax rate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
