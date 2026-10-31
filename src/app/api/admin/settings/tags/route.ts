import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { listTagTypes, createTagType } from "@/lib/admin/tag-queries";
import { tagTypeInputSchema, TAG_ENTITIES, type TagEntity } from "@/lib/admin/tag-types";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Upper bound on tag types per org. */
const MAX_TAG_TYPES = 100;

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:tags-list:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const params = request.nextUrl.searchParams;
    const entityParam = params.get("entity");
    if (entityParam !== null && !(TAG_ENTITIES as readonly string[]).includes(entityParam)) {
      return errorResponse("Invalid entity", "VALIDATION_ERROR", 400);
    }
    const tags = await listTagTypes(session.organizationId, {
      ...(entityParam ? { entity: entityParam as TagEntity } : {}),
      ...(params.get("active") === "1" ? { activeOnly: true } : {}),
    });
    return successResponse({ tags });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list tag types");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:tags-create:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = tagTypeInputSchema.safeParse(body.data);
    if (!parsed.success) {
      return errorResponse("Invalid tag: " + parsed.error.issues[0]?.message, "VALIDATION_ERROR", 400);
    }

    const existing = await listTagTypes(session.organizationId);
    if (existing.length >= MAX_TAG_TYPES) {
      return errorResponse(`You can have at most ${MAX_TAG_TYPES} tags.`, "LIMIT_REACHED", 409);
    }

    const result = await createTagType(session.organizationId, parsed.data);
    if ("conflict" in result) {
      return errorResponse("A tag with that name already exists for this type.", "DUPLICATE_NAME", 409);
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_tag_type",
      entity: "tag_types",
      entityId: result.id,
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit tag type creation");
    });

    return successResponse({ tag: result }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create tag type");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
