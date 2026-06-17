import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import {
  listAttachmentsForEntity,
  entityBelongsToOrg,
  type EntityScope,
} from "@/lib/admin/attachment-queries";
import { db } from "@/lib/db";
import { attachments } from "@/lib/db/schema";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import {
  getStorageClient,
  generateAdminStorageKey,
  ADMIN_DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_FILE_SIZE,
} from "@/lib/storage/r2-client";

export const runtime = "nodejs";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads exactly one entity scope from query params (GET) or form fields (POST).
 * Returns the scope, or an error code when zero or more than one is provided.
 */
function readScope(get: (key: string) => string | null):
  | { ok: true; scope: EntityScope }
  | { ok: false; code: "MISSING_SCOPE" | "MULTIPLE_SCOPES" | "INVALID_ID" } {
  const serviceRequestId = get("serviceRequestId");
  const equipmentId = get("equipmentId");
  const customerId = get("customerId");

  const provided = [serviceRequestId, equipmentId, customerId].filter(
    (v): v is string => v !== null && v !== "",
  );
  if (provided.length === 0) {
    return { ok: false, code: "MISSING_SCOPE" };
  }
  if (provided.length > 1) {
    return { ok: false, code: "MULTIPLE_SCOPES" };
  }
  const id = provided[0];
  if (!UUID_REGEX.test(id)) {
    return { ok: false, code: "INVALID_ID" };
  }

  if (serviceRequestId) return { ok: true, scope: { serviceRequestId: id } };
  if (equipmentId) return { ok: true, scope: { equipmentId: id } };
  return { ok: true, scope: { customerId: id } };
}

/**
 * GET /api/admin/attachments?serviceRequestId=… | equipmentId=… | customerId=…
 *
 * Lists attachments linked to a single entity, tenant-scoped. Never returns the
 * raw storage key — the client fetches a signed URL per attachment from
 * /api/admin/attachments/[id]/download.
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:attachments-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const params = request.nextUrl.searchParams;
    const scopeResult = readScope((k) => params.get(k));
    if (!scopeResult.ok) {
      return errorResponse(
        "Provide exactly one valid entity id (serviceRequestId, equipmentId, or customerId)",
        scopeResult.code,
        400,
      );
    }

    const rows = await listAttachmentsForEntity(
      session.organizationId,
      scopeResult.scope,
    );
    return successResponse({ attachments: rows });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list attachments");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

/**
 * POST /api/admin/attachments  (multipart/form-data)
 *
 * Uploads a file and links it to a single entity in one step. Fields:
 *   - file: the file
 *   - serviceRequestId | equipmentId | customerId: exactly one target
 *
 * Verifies the target entity belongs to the admin's org BEFORE uploading, so a
 * caller can't attach media to another org's records. Accepts images
 * (jpeg/png/webp/heic) and PDF, validated by magic bytes in the storage client.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:attachment-upload:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const formData = await request.formData();
    const scopeResult = readScope((k) => {
      const v = formData.get(k);
      return typeof v === "string" ? v : null;
    });
    if (!scopeResult.ok) {
      return errorResponse(
        "Provide exactly one valid entity id (serviceRequestId, equipmentId, or customerId)",
        scopeResult.code,
        400,
      );
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return errorResponse("No file provided", "NO_FILE", 400);
    }

    // The target entity must belong to this org (FKs only prove existence).
    const owns = await entityBelongsToOrg(
      session.organizationId,
      scopeResult.scope,
    );
    if (!owns) {
      return errorResponse("Target entity not found", "NOT_FOUND", 404);
    }

    const storageClient = getStorageClient();
    const validatedMime = storageClient.validateFile(
      file,
      MAX_DOCUMENT_FILE_SIZE,
      ADMIN_DOCUMENT_MIME_TYPES,
    );
    if (!validatedMime) {
      return errorResponse(
        `Invalid file. Allowed: JPEG, PNG, WebP, HEIC, PDF under ${
          MAX_DOCUMENT_FILE_SIZE / 1024 / 1024
        }MB.`,
        "INVALID_FILE",
        400,
      );
    }

    const storageKey = generateAdminStorageKey(
      session.organizationId,
      file.name,
    );

    let uploadResult;
    try {
      uploadResult = await storageClient.uploadFile(
        file,
        storageKey,
        validatedMime,
      );
    } catch (uploadError) {
      logger.error(
        { error: uploadError, orgId: session.organizationId },
        "Admin file upload failed",
      );
      return errorResponse("Failed to upload file", "UPLOAD_FAILED", 500);
    }

    const [attachment] = await db
      .insert(attachments)
      .values({
        organizationId: session.organizationId,
        sessionId: null,
        messageId: null,
        serviceRequestId: scopeResult.scope.serviceRequestId ?? null,
        equipmentId: scopeResult.scope.equipmentId ?? null,
        customerId: scopeResult.scope.customerId ?? null,
        filename: file.name,
        mimeType: validatedMime,
        size: file.size,
        storageKey: uploadResult.storageKey,
      })
      .returning();

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "attachment_uploaded",
      entity: "attachment",
      entityId: attachment.id,
      // ids/enums only — never the filename (free text) or storage key.
      details: JSON.stringify({
        mimeType: validatedMime,
        size: file.size,
        serviceRequestId: scopeResult.scope.serviceRequestId ?? null,
        equipmentId: scopeResult.scope.equipmentId ?? null,
        customerId: scopeResult.scope.customerId ?? null,
      }),
    });

    return successResponse(
      {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        serviceRequestId: attachment.serviceRequestId,
        equipmentId: attachment.equipmentId,
        customerId: attachment.customerId,
        createdAt: attachment.createdAt,
      },
      201,
    );
  } catch (error: unknown) {
    logger.error({ error }, "Failed to upload admin attachment");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
