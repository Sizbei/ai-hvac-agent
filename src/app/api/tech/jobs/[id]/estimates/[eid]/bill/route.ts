/**
 * POST /api/tech/jobs/[id]/estimates/[eid]/bill — put a sold estimate's lines
 * on the job's invoice, once per estimate (M3c spec §5.3). Invoicing statuses,
 * estimate copy (plan ruling 3) → `{}` body → key → idempotent run → 200
 * `{ invoiceId, added, hasMaterials }`; audit `estimate_billed` on a fresh add.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api-response";
import { isUuid } from "@/lib/validation/uuid";
import { logger, errorCode } from "@/lib/logger";
import { BILL_PREAMBLE, techWritePreamble } from "@/lib/tech/invoice-route-guards";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { billSoldEstimate } from "@/lib/admin/invoice-field-writes";
import { estimateReasonResult } from "@/lib/tech/estimate-errors";

export const dynamic = "force-dynamic";

const billSchema = z.object({}).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; eid: string }> }) {
  try {
    const { id, eid } = await params;
    const pre = await techWritePreamble(request, id, BILL_PREAMBLE);
    if (!pre.ok) return pre.response;
    if (!isUuid(eid)) return errorResponse("That estimate isn't on this job.", "NOT_FOUND", 404);
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, billSchema, true);
    if (!body.ok) return body.response;
    const key = readKey(request);
    if (!key.ok) return key.response;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async (ids) => {
        const r = await billSoldEstimate({ organizationId, requestId: pre.requestId, techUserId: userId }, eid, { invoiceId: ids.id("invoice") });
        if (!r.ok) return estimateReasonResult(r.reason, r.reason === "already_billed" && r.invoiceId ? { invoiceId: r.invoiceId } : undefined);
        return okResult(200, { invoiceId: r.invoiceId, added: r.added, hasMaterials: r.hasMaterials });
      },
    );
    if (result.envelope.success && !result.replayed) {
      const { invoiceId, added } = result.envelope.data as { invoiceId: string; added: number };
      await auditWrite({
        organizationId, userId, action: "estimate_billed", entity: "estimate", entityId: eid,
        details: `estimateId:${eid} invoiceId:${invoiceId} added:${added}`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to bill field estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
