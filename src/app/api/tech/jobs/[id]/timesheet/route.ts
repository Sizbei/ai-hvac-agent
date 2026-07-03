/**
 * Technician labor tracking — clock in / clock out per job.
 *
 * GET   list the time entries on a job (org-scoped read) + whether THIS tech has
 *       an open entry (so the UI can show Clock In vs Clock Out + elapsed time).
 * POST  { action: "clock_in" | "clock_out" } — assignee + tenant guarded in
 *       timesheet-queries.
 *
 * Auth mirrors the tech materials route: getTechSession (technician session) +
 * the assignee+tenant guard lives in the query layer.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import { isJobOwnedByTech } from "@/lib/tech/field-queries";
import {
  clockIn,
  clockOut,
  listTimeEntries,
} from "@/lib/tech/timesheet-queries";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  action: z.enum(["clock_in", "clock_out"]),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { id } = await params;
    if (!(await isJobOwnedByTech(session.organizationId, session.userId, id))) {
      return errorResponse("Job not found", "NOT_FOUND", 404);
    }
    const entries = await listTimeEntries(session.organizationId, id);
    // Whether the CURRENT tech is on the clock for this job (drives the toggle).
    const openEntry =
      entries.find(
        (e) => e.technicianId === session.userId && e.clockOutAt === null,
      ) ?? null;
    // Strip BOTH laborRateCents AND laborCostCents — payroll data. Either one
    // alone (or laborCostCents / minutes) lets any tech derive a colleague's exact
    // hourly wage from a shared job's entries.
    const publicEntries = entries.map(
      ({
        laborRateCents: _laborRateCents,
        laborCostCents: _laborCostCents,
        ...rest
      }) => rest,
    );
    return successResponse({
      entries: publicEntries,
      open: openEntry ? { id: openEntry.id, clockInAt: openEntry.clockInAt } : null,
    });
  } catch (error) {
    logger.error({ error }, "Failed to list time entries");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const rate = slidingWindow(
      `tech:timesheet:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid action", "INVALID_INPUT", 400);
    }

    if (parsed.data.action === "clock_in") {
      const result = await clockIn(session.organizationId, session.userId, id);
      if (!result.ok) {
        if (result.reason === "not_owned") {
          return errorResponse(
            "Job not found or not assigned to you",
            "NOT_FOUND",
            404,
          );
        }
        return errorResponse("Already clocked in", "ALREADY_OPEN", 409);
      }
      logger.info(
        { serviceRequestId: id, technicianId: session.userId, entryId: result.id },
        "Technician clocked in",
      );
      return successResponse({ id: result.id }, 201);
    }

    // clock_out
    const result = await clockOut(session.organizationId, session.userId, id);
    if (!result.ok) {
      if (result.reason === "not_owned") {
        return errorResponse(
          "Job not found or not assigned to you",
          "NOT_FOUND",
          404,
        );
      }
      return errorResponse("Not clocked in", "NO_OPEN_ENTRY", 409);
    }
    logger.info(
      {
        serviceRequestId: id,
        technicianId: session.userId,
        entryId: result.id,
        minutes: result.minutes,
      },
      "Technician clocked out",
    );
    return successResponse({
      id: result.id,
      minutes: result.minutes,
      laborCostCents: result.laborCostCents,
    });
  } catch (error) {
    logger.error({ error }, "Failed to record time entry");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
