import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  listInvoices,
  getInvoiceSummaryStats,
  collectedThisMonthCents,
  createInvoiceFromSoldEstimate,
  INVOICE_SORT_KEYS,
  type InvoiceSortKey,
} from "@/lib/admin/invoice-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { logger } from "@/lib/logger";
import { invoiceStateEnum } from "@/lib/db/schema";

const VALID_STATES = new Set(invoiceStateEnum.enumValues);
const VALID_SOURCES = new Set(["native", "fieldpulse", "housecall"]);

const createSchema = z.object({
  estimateId: z.string().uuid(),
});

export async function GET(request: NextRequest) {
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

    const sp = request.nextUrl.searchParams;

    const rawPage = Number(sp.get("page") ?? "1");
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

    const rawLimit = Number(sp.get("limit") ?? "50");
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), 20000)
      : 50;

    const search = sp.get("search")?.trim() || undefined;

    const rawState = sp.get("state") ?? "";
    const state = rawState && VALID_STATES.has(rawState as never) ? rawState : undefined;

    const rawSource = sp.get("source") ?? "";
    const source = rawSource && VALID_SOURCES.has(rawSource) ? rawSource : undefined;

    const customerId = sp.get("customerId") || undefined;
    const serviceRequestId = sp.get("serviceRequestId") || undefined;

    const rawSort = sp.get("sort") ?? "";
    const sort = INVOICE_SORT_KEYS.has(rawSort as InvoiceSortKey) ? (rawSort as InvoiceSortKey) : undefined;

    const overdue = sp.get("overdue") === "1";
    const unreminded = sp.get("unreminded") === "1";

    // Reject out-of-range amount filters with a 400: silently dropping them
    // would make the UI show all invoices as if no filter were applied,
    // which is confusing and potentially misleading.
    const INT32_MAX = 2_147_483_647;
    const inCentsRange = (n: number) => Number.isFinite(n) && n >= 0 && n <= INT32_MAX;

    const rawMinStr = sp.get("minCents");
    const rawMaxStr = sp.get("maxCents");
    const rawMinCents = rawMinStr !== null ? parseInt(rawMinStr, 10) : NaN;
    const rawMaxCents = rawMaxStr !== null ? parseInt(rawMaxStr, 10) : NaN;

    if (rawMinStr !== null && !inCentsRange(rawMinCents)) {
      return errorResponse("Amount filter out of range", "VALIDATION_ERROR", 400);
    }
    if (rawMaxStr !== null && !inCentsRange(rawMaxCents)) {
      return errorResponse("Amount filter out of range", "VALIDATION_ERROR", 400);
    }

    const minCents = rawMinStr !== null ? rawMinCents : undefined;
    const maxCents = rawMaxStr !== null ? rawMaxCents : undefined;

    if (minCents !== undefined && maxCents !== undefined && minCents > maxCents) {
      return errorResponse("minCents must be ≤ maxCents", "VALIDATION_ERROR", 400);
    }

    const [listResult, stats, collected] = await Promise.all([
      listInvoices(session.organizationId, { page, limit, search, state, overdue, source, sort, customerId, serviceRequestId, unreminded, minCents, maxCents }),
      getInvoiceSummaryStats(session.organizationId),
      collectedThisMonthCents(session.organizationId),
    ]);

    const response = successResponse({
      invoices: listResult.invoices,
      total: listResult.total,
      sourceCounts: listResult.sourceCounts,
      stats,
      collectedThisMonthCents: collected,
    });
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

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      return errorResponse("Invalid JSON body", "VALIDATION_ERROR", 400);
    }
    const parsed = createSchema.safeParse(bodyResult.data);
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
