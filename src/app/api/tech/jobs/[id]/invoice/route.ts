/**
 * GET /api/tech/jobs/[id]/invoice — the field invoice screen (spec §6.2.1).
 * Tech session → UUID → read rate limit → the view: not readable → 404 (never
 * confirming the job exists), FieldPulse/HCP job → 409 MANAGED_EXTERNALLY.
 *
 * POST — adopt or create the job's draft invoice (spec §6.2): preamble → `{}`
 * body (absent/empty is `{}`) → idempotency key → idempotent run → 201 when
 * created, 200 on adopt; audit `invoice_created` on a fresh (non-replayed) run.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { getTechInvoiceView } from "@/lib/tech/invoice-queries";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { techWritePreamble } from "@/lib/tech/invoice-route-guards";
import { reasonResult } from "@/lib/tech/invoice-errors";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { createInvoiceFromJob } from "@/lib/admin/invoice-field-writes";

export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(
      `tech:invoice:read:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    }
    const result = await getTechInvoiceView(session.organizationId, session.userId, id);
    if (result.kind === "not_found") return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    if (result.kind === "external") {
      return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
    }
    return successResponse(result.view);
  } catch (error) {
    logger.error({ error }, "Failed to load tech invoice view");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}

const createSchema = z.object({}).strict();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const pre = await techWritePreamble(request, id);
    if (!pre.ok) return pre.response;
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, createSchema, true);
    if (!body.ok) return body.response;
    const key = readKey(request);
    if (!key.ok) return key.response;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async (ids) => {
        const r = await createInvoiceFromJob(
          { organizationId, requestId: pre.requestId, techUserId: userId },
          { invoiceId: ids.id("invoice") },
        );
        if (!r.ok) return reasonResult(r.reason);
        return okResult(r.created ? 201 : 200, { invoiceId: r.invoiceId, state: r.state, created: r.created });
      },
    );

    if (result.envelope.success && !result.replayed) {
      const { invoiceId, created } = result.envelope.data as { invoiceId: string; created: boolean };
      await auditWrite({
        organizationId, userId, action: "invoice_created", entity: "invoice", entityId: invoiceId,
        details: `invoiceId:${invoiceId} created:${created}`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ error }, "Failed to create tech invoice");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
