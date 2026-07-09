import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  listInvoices,
  collectedThisMonthCents,
  createInvoiceFromSoldEstimate,
} from "@/lib/admin/invoice-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

const createSchema = z.object({
  estimateId: z.string().uuid(),
});

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:invoices-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const invoices = await listInvoices(session.organizationId);
    const collected = await collectedThisMonthCents(session.organizationId);
    const response = successResponse({ invoices, collectedThisMonthCents: collected });
    response.headers.set('Cache-Control', 'private, max-age=0, stale-while-revalidate=30');
    return response;
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list invoices");
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
      `admin:invoices-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid request", "VALIDATION_ERROR", 400);
    }

    const result = await createInvoiceFromSoldEstimate(
      session.organizationId,
      parsed.data.estimateId,
    );

    if (!result.ok) {
      switch (result.reason) {
        case "synced_read_only":
          return errorResponse(
            "This estimate is synced from FieldPulse — invoicing is managed there",
            "SYNCED_READ_ONLY",
            409,
          );
        case "estimate_not_sold":
          return errorResponse(
            "Only a sold estimate can be invoiced",
            "ESTIMATE_NOT_SOLD",
            409,
          );
        case "no_sold_option":
          return errorResponse(
            "The sold estimate has no chosen option",
            "NO_SOLD_OPTION",
            400,
          );
        default:
          return errorResponse("Could not create invoice", "VALIDATION_ERROR", 400);
      }
    }

    // ids only — no customer PII.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "invoice_created",
      entity: "invoice",
      entityId: result.invoiceId,
      details: `estimateId:${parsed.data.estimateId}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, invoiceId: result.invoiceId },
        "Failed to write audit log for invoice creation",
      );
    });

    return successResponse({ invoiceId: result.invoiceId }, 201);
  } catch (error: unknown) {
    // The per-estimate unique index can race two concurrent creates — surface
    // as a clean 409 rather than a 500.
    if (isUniqueViolation(error)) {
      return errorResponse(
        "An invoice for this estimate already exists",
        "INVOICE_ALREADY_EXISTS",
        409,
      );
    }
    logger.error({ error }, "Failed to create invoice");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
