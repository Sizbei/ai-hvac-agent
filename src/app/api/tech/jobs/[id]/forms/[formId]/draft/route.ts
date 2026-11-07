/**
 * PUT /api/tech/jobs/[id]/forms/[formId]/draft — autosave (M3d spec §4.2,
 * §5.2). No idempotency key: the body's `saveId` makes a retry a replay — checked
 * FIRST, before the gates, so a retry of a landed write answers 200 even after
 * the visit ended — and the revision gate refuses anything else as STALE. 201
 * on the first write (the row was created), 200 after. No audit.
 */
import type { NextRequest } from "next/server";
import { errorResponse, successResponse } from "@/lib/api-response";
import { errorCode, logger } from "@/lib/logger";
import { readWriteBody } from "@/lib/tech/invoice-write-route";
import { techFormFront, techFormGate } from "@/lib/tech/form-route-guards";
import { draftBodySchema } from "@/lib/forms/form-bodies";
import { findDraftReplay, saveFormDraft } from "@/lib/tech/form-writes";
import { formReasonResponse } from "@/lib/tech/form-errors";

export const dynamic = "force-dynamic";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string; formId: string }> }) {
  try {
    const { id, formId } = await params;
    const front = await techFormFront(request, id, formId, "form-draft");
    if (!front.ok) return front.response;
    const body = await readWriteBody(request, draftBodySchema);
    if (!body.ok) return body.response;
    const { organizationId, userId } = front.session;
    const actor = { organizationId, requestId: id.toLowerCase(), techUserId: userId };
    const replay = await findDraftReplay(actor, { ...body.data, formId });
    if (replay?.ok) return successResponse({ submissionId: replay.submissionId, revision: replay.revision, savedAt: replay.savedAt }, 200);
    const gate = await techFormGate(front.session, id, formId, body.data.appointmentId);
    if (!gate.ok) return gate.response;
    const r = await saveFormDraft(actor, { ...body.data, formId });
    if (!r.ok) return formReasonResponse(r);
    return successResponse({ submissionId: r.submissionId, revision: r.revision, savedAt: r.savedAt }, r.created ? 201 : 200);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to save form draft");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}
