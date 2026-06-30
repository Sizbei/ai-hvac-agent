/**
 * Technician field workflow — post an on-site note from the field.
 *
 * Reuses the request_notes mechanism (the tech is the author). Assignee + tenant
 * guarded in field-queries. Auth mirrors the tech status route.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import { addFieldNote } from "@/lib/tech/field-queries";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ content: z.string().trim().min(1).max(2000) });

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
      `tech:note:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    const parsed = bodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid note", "INVALID_INPUT", 400);
    }

    const result = await addFieldNote(
      session.organizationId,
      session.userId,
      id,
      parsed.data.content,
    );
    if (!result.ok) {
      if (result.reason === "not_owned") {
        return errorResponse(
          "Job not found or not assigned to you",
          "NOT_FOUND",
          404,
        );
      }
      return errorResponse("Invalid note", "INVALID_INPUT", 400);
    }

    logger.info(
      { serviceRequestId: id, technicianId: session.userId, noteId: result.id },
      "Technician posted field note",
    );
    return successResponse({ id: result.id }, 201);
  } catch (error) {
    logger.error({ error }, "Failed to post field note");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
