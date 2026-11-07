/**
 * Technician field workflow — upload a job photo from the field.
 *
 * Accepts a multipart file, validates it via r2-client (images incl. iOS HEIC +
 * PDF — the ADMIN_DOCUMENT allowlist, not the JPEG/PNG-only public one), uploads
 * to R2, then records the metadata in the shared attachments table linked to the
 * job. Ownership is enforced in addJobPhoto (assignee + tenant); on a non-assignee
 * we delete the orphaned upload and 404, keeping the guard authoritative in one
 * place — mirrors the signature route. M3d: 4 MB cap (the phone resizes to it;
 * Vercel caps bodies at 4.5 MB), uuid check on POST, and the insert runs under
 * the request lock and refuses an erased customer (409 CUSTOMER_REMOVED, the
 * uploaded object deleted).
 */
import { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { listJobPhotos, isJobOwnedByTech } from "@/lib/tech/field-queries";
import { addJobPhoto } from "@/lib/tech/photo-writes";
import { FILE_TOO_LARGE_COPY, TECH_UPLOAD_LIMIT_BYTES } from "@/lib/tech/upload-limits";
import {
  getStorageClient,
  generateStorageKey,
  ADMIN_DOCUMENT_MIME_TYPES,
  verifyMagicBytes,
} from "@/lib/storage/r2-client";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";

export const runtime = "nodejs";

const INVALID_FILE_COPY = "Invalid file. Allowed: JPEG, PNG, WEBP, HEIC, or PDF (max 4 MB).";
export const dynamic = "force-dynamic";

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
      `tech:photo:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!isUuid(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return errorResponse("A photo file is required", "INVALID_INPUT", 400);
    }
    if (file.size > TECH_UPLOAD_LIMIT_BYTES) {
      return errorResponse(FILE_TOO_LARGE_COPY, "INVALID_INPUT", 400);
    }

    const storageClient = getStorageClient();
    // HEIC is included so iPhone photos upload directly (the public JPEG/PNG-only
    // allowlist would reject them).
    const validatedMime = storageClient.validateFile(
      file,
      TECH_UPLOAD_LIMIT_BYTES,
      ADMIN_DOCUMENT_MIME_TYPES,
    );
    if (!validatedMime) {
      return errorResponse(INVALID_FILE_COPY, "INVALID_INPUT", 400);
    }
    // Bytes that don't match the declared type are a bad file, not a server
    // fault (uploadFile would otherwise throw and answer 500).
    if (!verifyMagicBytes(await file.arrayBuffer(), validatedMime)) {
      return errorResponse(INVALID_FILE_COPY, "INVALID_INPUT", 400);
    }

    // Verify ownership BEFORE uploading so a non-assignee can't write to storage.
    if (!(await isJobOwnedByTech(session.organizationId, session.userId, id))) {
      return errorResponse(
        "Job not found or not assigned to you",
        "NOT_FOUND",
        404,
      );
    }

    const storageKey = generateStorageKey(session.organizationId, id, file.name);
    await storageClient.uploadFile(file, storageKey, validatedMime);

    const deleteOrphan = () =>
      storageClient.deleteFile(storageKey).catch(() => {
        logger.warn({ storageKey, serviceRequestId: id }, "orphan upload delete failed");
      });
    let result: Awaited<ReturnType<typeof addJobPhoto>>;
    try {
      result = await addJobPhoto(session.organizationId, session.userId, id, {
        filename: file.name,
        mimeType: validatedMime,
        size: file.size,
        storageKey,
      });
    } catch (e) {
      // No attachments row points at the object, so erase could never reach it.
      await deleteOrphan();
      throw e;
    }
    if (!result.ok) {
      // Race: the job was reassigned, or its customer erased, between the
      // ownership check and the write. Clean up the orphaned upload first.
      await deleteOrphan();
      if (result.reason === "stale") {
        return errorResponse("This job changed. Try again.", "STALE", 409);
      }
      if (result.reason === "customer_removed") {
        return errorResponse("This job's customer was removed.", "CUSTOMER_REMOVED", 409);
      }
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
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { id } = await params;
    if (!isUuid(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }
    if (!(await isJobOwnedByTech(session.organizationId, session.userId, id))) {
      return errorResponse("Job not found", "NOT_FOUND", 404);
    }
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
