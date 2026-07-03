/**
 * Technician field workflow — materials used on a job.
 *
 * GET    list the materials recorded on a job (org-scoped read).
 * POST   add a material (catalog line snapshots cost/price server-side; manual
 *        line defaults costs to 0). Assignee + tenant guarded in field-queries.
 * DELETE remove a material by ?materialId=. Assignee + tenant guarded.
 *
 * Auth mirrors the tech status route: getTechSession (technician role) + the
 * assignee+tenant guard lives in the query layer.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { getTechSession } from "@/lib/auth/tech-session";
import {
  addJobMaterial,
  listJobMaterials,
  removeJobMaterial,
  isJobOwnedByTech,
} from "@/lib/tech/field-queries";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const addSchema = z.object({
  pricebookItemId: z.string().uuid().optional(),
  description: z.string().trim().min(1).max(500).optional(),
  quantity: z.number().int().min(1).max(10000),
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
    const materials = await listJobMaterials(session.organizationId, id);
    // Strip unitCostCents — vendor cost / margin data. Techs get unitPriceCents
    // (what the customer is charged); exposing cost contradicts the H13/M34
    // cost-hiding intent.
    const publicMaterials = materials.map(
      ({ unitCostCents: _unitCostCents, ...rest }) => rest,
    );
    return successResponse({ materials: publicMaterials });
  } catch (error) {
    logger.error({ error }, "Failed to list job materials");
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
      `tech:materials:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    const parsed = addSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid material", "INVALID_INPUT", 400);
    }

    const result = await addJobMaterial(session.organizationId, session.userId, id, {
      pricebookItemId: parsed.data.pricebookItemId ?? null,
      description: parsed.data.description ?? null,
      quantity: parsed.data.quantity,
    });
    if (!result.ok) {
      if (result.reason === "not_owned") {
        return errorResponse(
          "Job not found or not assigned to you",
          "NOT_FOUND",
          404,
        );
      }
      if (result.reason === "item_not_found") {
        return errorResponse("Pricebook item not found", "NOT_FOUND", 404);
      }
      return errorResponse("Invalid material", "INVALID_INPUT", 400);
    }

    logger.info(
      { serviceRequestId: id, technicianId: session.userId, materialId: result.id },
      "Technician recorded job material",
    );
    return successResponse({ id: result.id }, 201);
  } catch (error) {
    logger.error({ error }, "Failed to add job material");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function DELETE(
  request: NextRequest,
  _ctx: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const rate = slidingWindow(
      `tech:materials:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const materialId = request.nextUrl.searchParams.get("materialId");
    if (!materialId) {
      return errorResponse("materialId is required", "INVALID_INPUT", 400);
    }

    const result = await removeJobMaterial(
      session.organizationId,
      session.userId,
      materialId,
    );
    if (!result.ok) {
      return errorResponse(
        "Material not found or not assigned to you",
        "NOT_FOUND",
        404,
      );
    }
    return successResponse({ removed: true });
  } catch (error) {
    logger.error({ error }, "Failed to remove job material");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
