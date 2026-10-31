import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { listEntityTags, replaceEntityTags } from "@/lib/admin/tag-queries";
import { TAG_ENTITIES, type TagEntity } from "@/lib/admin/tag-types";
import { taggableExists } from "@/lib/admin/tag-entity-lookup";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bodySchema = z.object({ tagTypeIds: z.array(z.string().regex(UUID_REGEX)).max(20) });

function parseParams(p: { entity: string; id: string }): { entity: TagEntity; id: string } | null {
  if (!(TAG_ENTITIES as readonly string[]).includes(p.entity) || !UUID_REGEX.test(p.id)) return null;
  return { entity: p.entity as TagEntity, id: p.id };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ entity: string; id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:tags-get:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const p = parseParams(await params);
    if (!p || !(await taggableExists(session.organizationId, p.entity, p.id))) return errorResponse("Not found", "NOT_FOUND", 404);
    const map = await listEntityTags(session.organizationId, p.entity, [p.id]);
    return successResponse({ tags: map.get(p.id) ?? [] });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list entity tags");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ entity: string; id: string }> }) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:tags-put:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    const p = parseParams(await params);
    if (!p) return errorResponse("Not found", "NOT_FOUND", 404);
    const body = await readJsonBody(request);
    if (!body.ok) return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    const parsed = bodySchema.safeParse(body.data);
    if (!parsed.success) return errorResponse("Invalid tags", "VALIDATION_ERROR", 400);
    if (!(await taggableExists(session.organizationId, p.entity, p.id))) return errorResponse("Not found", "NOT_FOUND", 404);
    const result = await replaceEntityTags(session.organizationId, p.entity, p.id, parsed.data.tagTypeIds);
    if (!result.ok) {
      if (result.reason === "race") return errorResponse("Tags changed while you were editing. Reload and try again.", "RACE", 409);
      return errorResponse("One of those tags doesn't exist.", "UNKNOWN_TAG", 400);
    }
    await logAudit({ organizationId: session.organizationId, userId: session.userId, action: "replace_entity_tags", entity: `${p.entity}_tags`, entityId: p.id, details: JSON.stringify({ tagTypeIds: parsed.data.tagTypeIds }) })
      .catch((auditError: unknown) => logger.error({ error: auditError }, "Failed to audit tag change"));
    const map = await listEntityTags(session.organizationId, p.entity, [p.id]);
    return successResponse({ tags: map.get(p.id) ?? [] });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to replace entity tags");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
