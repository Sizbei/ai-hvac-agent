/**
 * POST /api/tech/jobs/[id]/invoice/finalize — CAS the job's newest draft
 * invoice to open, snapshotting the signature (spec §6.2). Preamble → body →
 * key → idempotent run (newest-target check, then the writer) → 200
 * `{ invoiceId, state, changed }`; audit `invoice_finalized` on a fresh run
 * that changed the invoice.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/api-response";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { techWritePreamble, resolveTarget } from "@/lib/tech/invoice-route-guards";
import { reasonResult } from "@/lib/tech/invoice-errors";
import { auditWrite, okResult, readKey, readWriteBody, targetRefusal } from "@/lib/tech/invoice-write-route";
import { finalizeInvoice } from "@/lib/admin/invoice-field-writes";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ invoiceId: z.string().uuid() }).strict();

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
    const { invoiceId } = body.data;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async () => {
        const target = await resolveTarget(organizationId, pre.requestId, invoiceId, "newest");
        if (target !== "ok") return targetRefusal(target);
        const r = await finalizeInvoice({ organizationId, requestId: pre.requestId, techUserId: userId }, invoiceId);
        if (!r.ok) return reasonResult(r.reason);
        return okResult(200, { invoiceId, state: r.state, changed: r.changed });
      },
    );

    if (result.envelope.success && !result.replayed && result.envelope.data.changed === true) {
      await auditWrite({
        organizationId, userId, action: "invoice_finalized", entity: "invoice", entityId: invoiceId,
        details: `invoiceId:${invoiceId}`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ error }, "Failed to finalize tech invoice");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
