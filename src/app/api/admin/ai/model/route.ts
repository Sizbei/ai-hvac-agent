/**
 * Super-admin AI model switcher.
 *
 *   GET  /api/admin/ai/model  -> { choices, selectedId }
 *   PUT  /api/admin/ai/model  { modelId } -> persist the org's selection
 *
 * Both are super_admin-gated (getAdminSession then isSuperAdmin else 403) and
 * write-rate-limited. The response carries the client-safe {id,label} choices
 * ONLY — never a baseUrl, an apiKeyEnv name, a modelId, or a key.
 */
import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { isSuperAdmin } from "@/lib/auth/authz";
import { db } from "@/lib/db";
import { organizationSettings } from "@/lib/db/schema";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { listModelChoices, getRegistryEntry } from "@/lib/ai/model-registry";

export async function GET(): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const [row] = await db
      .select({ aiModelId: organizationSettings.aiModelId })
      .from(organizationSettings)
      .where(eq(organizationSettings.organizationId, session.organizationId))
      .limit(1);

    return successResponse({
      choices: listModelChoices(),
      selectedId: row?.aiModelId ?? null,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to read AI model selection");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

const putSchema = z.object({
  modelId: z.string().trim().min(1, "modelId is required"),
});

export async function PUT(request: NextRequest): Promise<Response> {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (!isSuperAdmin(session)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }

    const rateCheck = slidingWindow(
      `admin:ai-model-set:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        parsed.error.issues[0]?.message ?? "Invalid request",
        "VALIDATION_ERROR",
        400,
      );
    }

    const { modelId } = parsed.data;
    if (!getRegistryEntry(modelId)) {
      return errorResponse("Unknown model id", "UNKNOWN_MODEL", 400);
    }

    // Upsert the settings row (it may not exist yet) — scoped to the caller's org.
    await db
      .insert(organizationSettings)
      .values({ organizationId: session.organizationId, aiModelId: modelId })
      .onConflictDoUpdate({
        target: organizationSettings.organizationId,
        set: { aiModelId: modelId, updatedAt: new Date() },
      });

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "ai_model_changed",
      entity: "organization_settings",
      entityId: session.organizationId,
      // A registry id is enum-like and safe — never a baseUrl/key.
      details: JSON.stringify({ modelId }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit AI model change");
    });

    return successResponse({ selectedId: modelId });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to set AI model selection");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
