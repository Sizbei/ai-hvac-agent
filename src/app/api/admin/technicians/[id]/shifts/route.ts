import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { listShifts, createShift } from "@/lib/admin/shift-queries";
import { shiftInputSchema } from "@/lib/admin/shift-types";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RANGE_DAYS = 90;
const MAX_RANGE_DAYS = 366;
const DATES_ERROR = "Check the dates and try again.";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const rateCheck = slidingWindow(
      `admin:shifts-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const { id } = await params;
    if (!UUID_REGEX.test(id)) return errorResponse("Technician not found", "NOT_FOUND", 404);

    const sp = request.nextUrl.searchParams;
    const fromParam = sp.get("from");
    const toParam = sp.get("to");
    const from = fromParam ? new Date(fromParam) : new Date();
    const to = toParam ? new Date(toParam) : new Date(from.getTime() + DEFAULT_RANGE_DAYS * DAY_MS);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      to <= from ||
      to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS
    ) {
      return errorResponse(DATES_ERROR, "VALIDATION_ERROR", 400);
    }

    const shifts = await listShifts(session.organizationId, id, from.toISOString(), to.toISOString());
    return successResponse({ shifts });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list shifts");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const rateCheck = slidingWindow(
      `admin:shifts-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const { id } = await params;
    if (!UUID_REGEX.test(id)) return errorResponse("Technician not found", "NOT_FOUND", 404);

    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse(DATES_ERROR, "VALIDATION_ERROR", 400);
    const parsed = shiftInputSchema.safeParse(body.data);
    if (!parsed.success) return errorResponse(DATES_ERROR, "VALIDATION_ERROR", 400);

    const result = await createShift(session.organizationId, id, parsed.data, session.userId);
    if ("reason" in result) {
      return errorResponse("Technician not found", "NOT_FOUND", 404);
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_shift",
      entity: "technician_shifts",
      entityId: result.id,
      details: JSON.stringify({
        technicianId: id,
        kind: result.kind,
        removesCapacity: result.removesCapacity,
      }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit shift creation");
    });

    return successResponse({ shift: result }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create shift");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
