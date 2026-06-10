import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  listWidgetKeys,
  createWidgetKey,
} from "@/lib/widget/key-queries";
import { KEY_TYPES } from "@/lib/widget/keys";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Cap on live keys per org — bounds the key table and the validate-lookup set. */
const MAX_KEYS = 25;

const createKeySchema = z.object({
  keyType: z.enum(KEY_TYPES),
  label: z.string().trim().max(80).optional(),
});

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:widget-keys-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const keys = await listWidgetKeys(session.organizationId);
    return successResponse({ keys });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list widget keys");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:widget-keys-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const body: unknown = await request.json();
    const parsed = createKeySchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        "Invalid key request: " + parsed.error.issues[0]?.message,
        "VALIDATION_ERROR",
        400,
      );
    }

    const existing = await listWidgetKeys(session.organizationId);
    if (existing.filter((k) => k.isActive).length >= MAX_KEYS) {
      return errorResponse(
        `You can have at most ${MAX_KEYS} active keys. Revoke one first.`,
        "LIMIT_REACHED",
        409,
      );
    }

    const created = await createWidgetKey(
      session.organizationId,
      parsed.data.keyType,
      parsed.data.label ?? null,
    );

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_widget_key",
      entity: "widget_keys",
      entityId: created.record.id,
      details: JSON.stringify({ keyType: parsed.data.keyType }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit key creation");
    });

    // The plaintext is returned ONCE here and never again.
    return successResponse(
      { key: created.record, plaintext: created.plaintext },
      201,
    );
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create widget key");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
