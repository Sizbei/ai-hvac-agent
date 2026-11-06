/**
 * POST /api/tech/jobs/[id]/estimates/[eid]/decline — "Customer declined"
 * (M3c spec §5.5): estimate preamble → `{}` → key → idempotent run → 200
 * `{ estimateId, status: "dismissed", created }`; audit `estimate_declined`
 * only when this call changed it.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api-response";
import { isUuid } from "@/lib/validation/uuid";
import { logger, errorCode } from "@/lib/logger";
import { ESTIMATE_PREAMBLE, techWritePreamble } from "@/lib/tech/invoice-route-guards";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { declineFieldEstimate } from "@/lib/tech/estimate-writes";
import { estimateReasonResult } from "@/lib/tech/estimate-errors";

export const dynamic = "force-dynamic";

const declineSchema = z.object({}).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; eid: string }> }) {
  try {
    const { id, eid } = await params;
    const pre = await techWritePreamble(request, id, ESTIMATE_PREAMBLE);
    if (!pre.ok) return pre.response;
    if (!isUuid(eid)) return errorResponse("That estimate isn't on this job.", "NOT_FOUND", 404);
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, declineSchema, true);
    if (!body.ok) return body.response;
    const key = readKey(request);
    if (!key.ok) return key.response;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async () => {
        const r = await declineFieldEstimate({ organizationId, requestId: pre.requestId, techUserId: userId }, eid);
        if (!r.ok) return estimateReasonResult(r.reason);
        return okResult(200, { estimateId: r.estimateId, status: "dismissed", created: r.created });
      },
    );
    if (result.envelope.success && !result.replayed && result.envelope.data.created === true) {
      await auditWrite({ organizationId, userId, action: "estimate_declined", entity: "estimate", entityId: eid, details: `estimateId:${eid}` });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to decline field estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
