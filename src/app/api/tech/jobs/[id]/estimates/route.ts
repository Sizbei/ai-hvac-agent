/**
 * GET /api/tech/jobs/[id]/estimates — the job's native estimates (M3c spec §6):
 * tech session → uuid → read rate limit → view (404 not readable, 409 on a
 * FieldPulse/HCP job). Never a cost field or a typed signature name.
 *
 * POST — build a field estimate (spec §5.1): estimate preamble → body → unique
 * option names → key → idempotent run → 201 created / 200 re-run; audit
 * `estimate_created` on a fresh create only.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import { rateKeyFor } from "@/lib/tech/tech-preview";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger, errorCode } from "@/lib/logger";
import { ESTIMATE_PREAMBLE, techWritePreamble } from "@/lib/tech/invoice-route-guards";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { getTechEstimatesView } from "@/lib/tech/estimate-queries";
import { createFieldEstimate } from "@/lib/tech/estimate-writes";
import { estimateReasonResult } from "@/lib/tech/estimate-errors";
import { hasDuplicateNames, MAX_LINES_PER_OPTION, MAX_OPTION_NAME, MAX_OPTIONS, MAX_QUANTITY } from "@/lib/tech/estimate-input";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(`tech:estimate:read:${rateKeyFor(session)}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    const r = await getTechEstimatesView(session.organizationId, session.userId, id);
    if (r.kind === "not_found") return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    if (r.kind === "external") return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
    return successResponse(r.view);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load tech estimates");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}

const lineSchema = z.object({ pricebookItemId: z.string().uuid(), quantity: z.number().int().min(1).max(MAX_QUANTITY) }).strict();
const optionSchema = z.object({
  name: z.string().trim().min(1).max(MAX_OPTION_NAME),
  lines: z.array(lineSchema).min(1).max(MAX_LINES_PER_OPTION),
}).strict();
const createSchema = z.object({ options: z.array(optionSchema).min(1).max(MAX_OPTIONS) }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pre = await techWritePreamble(request, id, ESTIMATE_PREAMBLE);
    if (!pre.ok) return pre.response;
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, createSchema);
    if (!body.ok) return body.response;
    if (hasDuplicateNames(body.data.options.map((o) => o.name))) {
      return errorResponse("Two options have the same name.", "INVALID_INPUT", 400);
    }
    const key = readKey(request);
    if (!key.ok) return key.response;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async (ids) => {
        const r = await createFieldEstimate({ organizationId, requestId: pre.requestId, techUserId: userId }, { estimateId: ids.id("estimate") }, body.data);
        if (!r.ok) return estimateReasonResult(r.reason);
        return okResult(r.created ? 201 : 200, { estimateId: r.estimateId, created: r.created });
      },
    );
    if (result.envelope.success && !result.replayed && result.envelope.data.created === true) {
      const estimateId = String(result.envelope.data.estimateId);
      await auditWrite({
        organizationId, userId, action: "estimate_created", entity: "estimate", entityId: estimateId,
        details: `estimateId:${estimateId} options:${body.data.options.length}`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to create field estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
