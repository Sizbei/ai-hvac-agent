/**
 * Technician general clock — a day clock with no job attached.
 *
 * GET   the technician's open general entry, or 404 when not clocked in.
 * POST  { action: "in" | "out" } — 201 on in, 409 ALREADY_OPEN if already in,
 *       200 with minutes on out, 404 when nothing is open.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import {
  closeGeneralEntry,
  getOpenGeneralEntry,
  openGeneralEntry,
} from "@/lib/tech/timesheet-queries";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ action: z.enum(["in", "out"]) });

export async function GET() {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const open = await getOpenGeneralEntry(session.organizationId, session.userId);
    if (!open) {
      return errorResponse("You're not clocked in.", "NOT_FOUND", 404);
    }
    return successResponse({ id: open.id, clockInAt: open.clockInAt });
  } catch (error) {
    logger.error({ error }, "Failed to read general clock");
    return errorResponse("Couldn't load your clock. Please try again.", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const rate = slidingWindow(
      `tech:time:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body = await readJsonBody(request);
    const parsed = body.ok ? bodySchema.safeParse(body.data) : null;
    if (!parsed?.success) {
      return errorResponse("Invalid action", "INVALID_INPUT", 400);
    }

    if (parsed.data.action === "in") {
      const result = await openGeneralEntry(session.organizationId, session.userId);
      if (!result.ok) {
        return errorResponse("You're already clocked in.", "ALREADY_OPEN", 409);
      }
      logger.info({ technicianId: session.userId, entryId: result.id }, "Technician clocked in (general)");
      return successResponse({ id: result.id }, 201);
    }

    const result = await closeGeneralEntry(session.organizationId, session.userId);
    if (!result.ok) {
      return errorResponse("You're not clocked in.", "NOT_FOUND", 404);
    }
    logger.info(
      { technicianId: session.userId, entryId: result.id, minutes: result.minutes },
      "Technician clocked out (general)",
    );
    return successResponse({ id: result.id, minutes: result.minutes });
  } catch (error) {
    logger.error({ error }, "Failed to record general clock");
    return errorResponse("Couldn't update your clock. Please try again.", "INTERNAL_ERROR", 500);
  }
}
