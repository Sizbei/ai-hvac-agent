/**
 * GET /api/tech/jobs/[id]/equipment — live units at the job's address by the
 * location rule, plus whether the caller may add or replace (M3c spec §6).
 * POST — add a unit or replace one (spec §5.6): equipment preamble (any
 * technician working the job) → body → semantic validation → key → idempotent
 * run → 201 created / 200 replay; audit `equipment_added` / `equipment_replaced`.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import { rateKeyFor } from "@/lib/tech/tech-preview";
import { isUuid } from "@/lib/validation/uuid";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { errorResponse, successResponse } from "@/lib/api-response";
import { logger, errorCode } from "@/lib/logger";
import { techEquipmentPreamble } from "@/lib/tech/invoice-route-guards";
import { auditWrite, okResult, readKey, readWriteBody } from "@/lib/tech/invoice-write-route";
import { canonicalHash, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { getTechEquipmentView } from "@/lib/tech/equipment-queries";
import { addFieldEquipment } from "@/lib/tech/equipment-writes";
import { equipmentReasonResult } from "@/lib/tech/equipment-errors";
import { EQUIPMENT_ERROR_COPY, parseEquipmentInput, todayInZone } from "@/lib/tech/equipment-input";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getTechSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    const rate = slidingWindow(`tech:equipment:read:${rateKeyFor(session)}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
    const r = await getTechEquipmentView(session.organizationId, session.userId, id);
    if (r.kind === "not_found") return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    if (r.kind === "external") return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
    return successResponse(r.view);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to load job equipment");
    return errorResponse("Something went wrong. Try again.", "INTERNAL_ERROR", 500);
  }
}

const text = z.string().max(400).optional();
const equipmentSchema = z.object({
  equipmentType: z.string(), make: text, model: text, serialNumber: text, locationInHome: text, notes: text,
  installDate: text, replacesId: z.string().uuid().optional(),
}).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pre = await techEquipmentPreamble(request, id);
    if (!pre.ok) return pre.response;
    const { organizationId, userId } = pre.session;
    const body = await readWriteBody(request, equipmentSchema);
    if (!body.ok) return body.response;
    const parsed = parseEquipmentInput(body.data, todayInZone(new Date()));
    if (!parsed.ok) return errorResponse(EQUIPMENT_ERROR_COPY[parsed.error], "INVALID_INPUT", 400);
    const key = readKey(request);
    if (!key.ok) return key.response;

    const result = await withIdempotency(
      { organizationId, userId, route: request.nextUrl.pathname, key: key.key },
      canonicalHash(body.data),
      async (ids) => {
        const r = await addFieldEquipment({ organizationId, requestId: pre.requestId, techUserId: userId }, { equipmentId: ids.id("equipment") }, parsed.value);
        if (!r.ok) return equipmentReasonResult(r.reason);
        return okResult(r.created ? 201 : 200, { equipmentId: r.equipmentId, created: r.created });
      },
    );
    if (result.envelope.success && !result.replayed && result.envelope.data.created === true) {
      const equipmentId = String(result.envelope.data.equipmentId);
      const replacesId = parsed.value.replacesId;
      await auditWrite({
        organizationId, userId, action: replacesId ? "equipment_replaced" : "equipment_added", entity: "equipment", entityId: equipmentId,
        details: replacesId ? `equipmentId:${equipmentId} replacesId:${replacesId}` : `equipmentId:${equipmentId}`,
      });
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ code: errorCode(error) }, "Failed to add field equipment");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
