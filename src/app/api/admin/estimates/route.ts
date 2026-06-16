import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { listEstimates, createEstimate } from "@/lib/admin/estimate-queries";
import { getDefaultTaxBps } from "@/lib/admin/pricebook-queries";
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

// taxBps is intentionally NOT accepted here — it is derived server-side from the
// org's default tax rate so a client cannot quote at a tampered rate.
const createSchema = z.object({
  serviceRequestId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  options: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        lineItems: z
          .array(
            z.object({
              pricebookItemId: z.string().uuid().nullable().optional(),
              name: z.string().trim().min(1).max(255),
              quantity: z.number().int().min(1),
              unitPriceCents: z.number().int().min(0),
            }),
          )
          .min(1),
      }),
    )
    .min(1)
    .max(10),
});

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:estimates-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const estimates = await listEstimates(session.organizationId);
    return successResponse({ estimates });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list estimates");
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
      `admin:estimates-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid estimate", "VALIDATION_ERROR", 400);
    }

    // Tax is the org's default rate, resolved server-side — never client-supplied.
    const taxBps = await getDefaultTaxBps(session.organizationId);

    const { estimateId, approvalToken } = await createEstimate(
      session.organizationId,
      {
        serviceRequestId: parsed.data.serviceRequestId ?? null,
        customerId: parsed.data.customerId ?? null,
        taxBps,
        options: parsed.data.options,
        expiresInDays: parsed.data.expiresInDays,
      },
    );

    // entityId only — never the one-time approval token (it's the bearer of
    // authority for the public e-sign page) or any customer PII.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "estimate_created",
      entity: "estimate",
      entityId: estimateId,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, estimateId },
        "Failed to write audit log for estimate creation",
      );
    });

    const approvalUrl = `${process.env.NEXT_PUBLIC_APP_URL}/estimates/${approvalToken}`;
    return successResponse({ estimateId, approvalToken, approvalUrl }, 201);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return errorResponse(
        "An estimate conflict occurred",
        "ESTIMATE_CONFLICT",
        409,
      );
    }
    logger.error({ error }, "Failed to create estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
