/**
 * POST /api/admin/financing — offer financing on an estimate or an invoice.
 * GET  /api/admin/financing?invoiceId|estimateId — list applications for display.
 *
 * Mock-first: getFinancingProvider() returns a MockFinancingProvider until a
 * lender contract + WISETACK_API_KEY exist. We surface only the provider's
 * applyUrl + status — never APR / monthly payment / Reg-Z terms.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  createFinancingApplication,
  listFinancingApplications,
} from "@/lib/admin/financing-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { logger } from "@/lib/logger";

// Exactly one of invoiceId / estimateId must be supplied.
const createSchema = z
  .object({
    invoiceId: z.string().uuid().optional(),
    estimateId: z.string().uuid().optional(),
    requestedAmountCents: z.number().int().min(1),
  })
  .refine((d) => (d.invoiceId ? 1 : 0) + (d.estimateId ? 1 : 0) === 1, {
    message: "Provide exactly one of invoiceId or estimateId",
  });

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:financing-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse(
        parsed.error.issues[0]?.message ?? "Invalid request",
        "VALIDATION_ERROR",
        400,
      );
    }

    const result = await createFinancingApplication(session.organizationId, {
      invoiceId: parsed.data.invoiceId,
      estimateId: parsed.data.estimateId,
      requestedAmountCents: parsed.data.requestedAmountCents,
    });

    if (!result.ok) {
      if (result.reason === "invoice_not_found") {
        return errorResponse("Invoice not found", "NOT_FOUND", 404);
      }
      // no_estimate_link — financing is keyed to an estimate; an invoice with no
      // estimate (or a missing estimate id) can't be financed via this path.
      return errorResponse(
        "No estimate to finance against",
        "NO_ESTIMATE_LINK",
        409,
      );
    }

    // Audit: ids/enums only — no money values, no PII, no APR.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "offer_financing",
      entity: "financing_application",
      entityId: result.application.id,
      details: `status=${result.application.status}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, applicationId: result.application.id },
        "Failed to write audit log for financing application",
      );
    });

    return successResponse({ application: result.application }, 201);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return errorResponse(
        "A financing application already exists",
        "FINANCING_ALREADY_EXISTS",
        409,
      );
    }
    logger.error({ error }, "Failed to create financing application");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:financing-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { searchParams } = new URL(request.url);
    const invoiceId = searchParams.get("invoiceId") ?? undefined;
    const estimateId = searchParams.get("estimateId") ?? undefined;
    const customerId = searchParams.get("customerId") ?? undefined;

    if (!invoiceId && !estimateId && !customerId) {
      return errorResponse(
        "Provide invoiceId, estimateId, or customerId",
        "VALIDATION_ERROR",
        400,
      );
    }

    const applications = await listFinancingApplications(session.organizationId, {
      invoiceId,
      estimateId,
      customerId,
    });
    return successResponse({ applications });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list financing applications");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
