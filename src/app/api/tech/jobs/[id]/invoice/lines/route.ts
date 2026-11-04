/**
 * POST /api/tech/jobs/[id]/invoice/lines — add a pricebook or job-material
 * line to the job's newest draft invoice (spec §6.2). Preamble → body → key →
 * idempotent run (newest-target check, then the writer) → 201
 * `{ lineId, invoiceId }`; audit `invoice_line_added` only when this run's
 * insert landed (not on a key replay, nor when the writer found the line —
 * e.g. the same material, whose line id is invoice-derived — already there).
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api-response";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { techWritePreamble, resolveTarget } from "@/lib/tech/invoice-route-guards";
import { reasonResult } from "@/lib/tech/invoice-errors";
import { auditWrite, okResult, readKey, readWriteBody, targetRefusal } from "@/lib/tech/invoice-write-route";
import { addInvoiceLine } from "@/lib/admin/invoice-field-writes";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const bodySchema = z.union([
  z.object({ invoiceId: z.string().uuid(), pricebookItemId: z.string().uuid(), quantity: z.number().int().min(1).max(999) }).strict(),
  z.object({ invoiceId: z.string().uuid(), jobMaterialId: z.string().uuid() }).strict(),
]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const pre = await techWritePreamble(request, id);
    if (!pre.ok) return pre.response;
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, bodySchema);
    if (!body.ok) return body.response;
    const key = readKey(request);
    if (!key.ok) return key.response;
    const { invoiceId, ...input } = body.data;
    let inserted = false;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async (ids) => {
        const target = await resolveTarget(organizationId, pre.requestId, invoiceId, "newest");
        if (target !== "ok") return targetRefusal(target);
        const r = await addInvoiceLine(
          { organizationId, requestId: pre.requestId, techUserId: userId }, invoiceId, { lineId: ids.id("line") }, input,
        );
        if (!r.ok) return reasonResult(r.reason);
        inserted = r.replayed !== true;
        return okResult(201, { lineId: r.lineId, invoiceId });
      },
    );

    if (inserted && result.envelope.success && !result.replayed) {
      const { lineId } = result.envelope.data as { lineId: string };
      await auditWrite({
        organizationId, userId, action: "invoice_line_added", entity: "invoice", entityId: invoiceId,
        details: `invoiceId:${invoiceId} lineId:${lineId}`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ error }, "Failed to add tech invoice line");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
