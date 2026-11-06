/**
 * POST /api/tech/jobs/[id]/estimates/[eid]/sell — the customer picked an option
 * and typed their name on the lead's phone (M3c spec §5.2). Estimate preamble →
 * estimate id → body (name ≥ 2 characters, never "(admin)") → key → idempotent
 * run → 200; audit `estimate_sold` on a fresh sale. Sell never bills.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api-response";
import { isUuid } from "@/lib/validation/uuid";
import { logger, errorCode } from "@/lib/logger";
import { ESTIMATE_PREAMBLE, techWritePreamble } from "@/lib/tech/invoice-route-guards";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { sellFieldEstimate } from "@/lib/tech/estimate-writes";
import { estimateReasonResult } from "@/lib/tech/estimate-errors";
import { MAX_SIGNATURE, signatureNameOk } from "@/lib/tech/estimate-input";

export const dynamic = "force-dynamic";

const sellSchema = z.object({ optionId: z.string().uuid(), signatureName: z.string().max(MAX_SIGNATURE * 2) }).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; eid: string }> }) {
  try {
    const { id, eid } = await params;
    const pre = await techWritePreamble(request, id, ESTIMATE_PREAMBLE);
    if (!pre.ok) return pre.response;
    if (!isUuid(eid)) return errorResponse("That estimate isn't on this job.", "NOT_FOUND", 404);
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, sellSchema);
    if (!body.ok) return body.response;
    if (!signatureNameOk(body.data.signatureName)) return errorResponse("Type your full name to approve.", "INVALID_INPUT", 400);
    const key = readKey(request);
    if (!key.ok) return key.response;
    const { optionId, signatureName } = body.data;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async () => {
        const r = await sellFieldEstimate({ organizationId, requestId: pre.requestId, techUserId: userId }, { estimateId: eid, optionId, signatureName });
        if (!r.ok) return estimateReasonResult(r.reason);
        return okResult(200, { estimateId: r.estimateId, status: "sold", created: r.created });
      },
    );
    if (result.envelope.success && !result.replayed && result.envelope.data.created === true) {
      await auditWrite({
        organizationId, userId, action: "estimate_sold", entity: "estimate", entityId: eid,
        details: `estimateId:${eid} optionId:${optionId} via:field`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to sell field estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
