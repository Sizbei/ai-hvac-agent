/**
 * POST /api/tech/jobs/[id]/forms/[formId]/submit — keyed submit (M3d spec
 * §4.3, §5.3). The request hash covers the visit, versions and an HMAC of the
 * canonical changes (labelled "hvac-form-changes-v1"), never the answers
 * themselves; `submit_key` = derivedId(scope, "form-submit"). The gates run
 * INSIDE the keyed run, so a retry of a submit that landed replays even after
 * the job closed (their codes are unstored: a refusal releases the key); a
 * takeover re-run of a submit that already committed is found by its derived
 * key BEFORE the gates and answers the writer's 200 (spec §5.3). The audit row
 * is written inside the writer's batch.
 */
import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api-response";
import { errorCode, logger } from "@/lib/logger";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { findSubmitReplay, formGateFail, techFormFront } from "@/lib/tech/form-route-guards";
import { submitBodySchema } from "@/lib/forms/form-bodies";
import { submitHashInput } from "@/lib/tech/form-submit-hash";
import { submitForm } from "@/lib/tech/form-writes";
import { formReasonResult } from "@/lib/tech/form-errors";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; formId: string }> }) {
  try {
    const { id, formId } = await params;
    const front = await techFormFront(request, id, formId, "form");
    if (!front.ok) return front.response;
    const body = await readWriteBody(request, submitBodySchema);
    if (!body.ok) return body.response;
    const key = readKey(request);
    if (!key.ok) return key.response;
    const { organizationId, userId } = front.session;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(submitHashInput(body.data)),
      async (ids) => {
        const submitKey = ids.id("form-submit");
        const landed = await findSubmitReplay(front.session, id, formId, body.data.appointmentId, submitKey);
        if (landed) return okResult(200, { submissionId: landed.submissionId, revision: landed.revision, submittedAt: landed.submittedAt });
        const gate = await formGateFail(front.session, id, formId, body.data.appointmentId);
        if (gate) return formReasonResult(gate);
        const r = await submitForm(
          { organizationId, requestId: id.toLowerCase(), techUserId: userId },
          { ...body.data, formId },
          { submitKey },
        );
        if (!r.ok) return formReasonResult(r);
        return okResult(200, { submissionId: r.submissionId, revision: r.revision, submittedAt: r.submittedAt });
      },
    );
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to submit form");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
