/**
 * Technician field workflow — upload a job photo from the field.
 *
 * Accepts a multipart file, validates it via r2-client (images incl. iOS HEIC +
 * PDF — the ADMIN_DOCUMENT allowlist, not the JPEG/PNG-only public one), uploads
 * to R2, then records the metadata in the shared attachments table linked to the
 * job. Ownership is enforced in addJobPhoto (assignee + tenant); on a non-assignee
 * we delete the orphaned upload and 404, keeping the guard authoritative in one
 * place — mirrors the signature route.
 */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { addJobPhoto, listJobPhotos } from "@/lib/tech/field-queries";
import {
  getStorageClient,
  generateStorageKey,
  MAX_DOCUMENT_FILE_SIZE,
  ADMIN_DOCUMENT_MIME_TYPES,
} from "@/lib/storage/r2-client";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const rate = slidingWindow(
      `tech:photo:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return errorResponse("A photo file is required", "INVALID_INPUT", 400);
    }

    const storageClient = getStorageClient();
    // HEIC is included so iPhone photos upload directly (the public JPEG/PNG-only
    // allowlist would reject them).
    const validatedMime = storageClient.validateFile(
      file,
      MAX_DOCUMENT_FILE_SIZE,
      ADMIN_DOCUMENT_MIME_TYPES,
    );
    if (!validatedMime) {
      return errorResponse(
        "Invalid file. Allowed: JPEG, PNG, WEBP, HEIC, or PDF (max 20 MB).",
        "INVALID_INPUT",
        400,
      );
    }

    const storageKey = generateStorageKey(session.organizationId, id, file.name);
    await storageClient.uploadFile(file, storageKey, validatedMime);

    const result = await addJobPhoto(session.organizationId, session.userId, id, {
      filename: file.name,
      mimeType: validatedMime,
      size: file.size,
      storageKey,
    });
    if (!result.ok) {
      // Not assigned to this tech — clean up the orphaned upload, then 404.
      await storageClient.deleteFile(storageKey).catch(() => {});
      return errorResponse(
        "Job not found or not assigned to you",
        "NOT_FOUND",
        404,
      );
    }

    logger.info(
      { serviceRequestId: id, technicianId: session.userId, attachmentId: result.id },
      "Technician uploaded job photo",
    );
    return successResponse({ id: result.id }, 201);
  } catch (error) {
    logger.error({ error }, "Failed to upload job photo");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { id } = await params;
    const photos = await listJobPhotos(session.organizationId, id);
    if (photos.length === 0) {
      return successResponse({ photos: [] });
    }
    // Sign each key into a short-lived display URL. Only construct the storage
    // client when there's something to sign (it requires R2 env to be set).
    const storageClient = getStorageClient();
    const withUrls = await Promise.all(
      photos.map(async (p) => ({
        id: p.id,
        filename: p.filename,
        mimeType: p.mimeType,
        size: p.size,
        createdAt: p.createdAt,
        url: await storageClient.getSignedReadUrl(p.storageKey).catch(() => null),
      })),
    );
    return successResponse({ photos: withUrls });
  } catch (error) {
    logger.error({ error }, "Failed to list job photos");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
