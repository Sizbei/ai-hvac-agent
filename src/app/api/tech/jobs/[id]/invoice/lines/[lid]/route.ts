/**
 * DELETE /api/tech/jobs/[id]/invoice/lines/[lid]?invoiceId= — remove a line
 * from the job's newest draft invoice (spec §6.2). No idempotency key: a
 * repeat is a 200 `{ removed: false }`. Audit `invoice_line_removed` only
 * when a row was removed.
 */
import type { NextRequest } from "next/server";
import { errorResponse, successResponse } from "@/lib/api-response";
import { isUuid } from "@/lib/validation/uuid";
import { techWritePreamble, resolveTarget } from "@/lib/tech/invoice-route-guards";
import { fieldError } from "@/lib/tech/invoice-errors";
import { auditWrite, invalidInput } from "@/lib/tech/invoice-write-route";
import { removeInvoiceLine } from "@/lib/admin/invoice-field-writes";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const refuse = (e: { status: number; code: string; message: string }) => errorResponse(e.message, e.code, e.status);

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; lid: string }> },
) {
  try {
    const { id, lid } = await params;
    const pre = await techWritePreamble(request, id);
    if (!pre.ok) return pre.response;
    const { organizationId, userId } = pre.session;
    const invoiceId = request.nextUrl.searchParams.get("invoiceId");
    if (!isUuid(lid) || !invoiceId || !isUuid(invoiceId)) return invalidInput();

    const target = await resolveTarget(organizationId, pre.requestId, invoiceId, "newest");
    if (target !== "ok") return refuse(fieldError(target === "stale" ? "stale" : "invoice_not_found"));
    const r = await removeInvoiceLine({ organizationId, requestId: pre.requestId, techUserId: userId }, invoiceId, lid);
    if (!r.ok) return refuse(fieldError(r.reason));

    if (r.removed) {
      await auditWrite({
        organizationId, userId, action: "invoice_line_removed", entity: "invoice", entityId: invoiceId,
        details: `invoiceId:${invoiceId} lineId:${lid}`,
      });
    }
    return successResponse({ removed: r.removed });
  } catch (error) {
    logger.error({ error }, "Failed to remove tech invoice line");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
