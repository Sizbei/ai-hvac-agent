/**
 * Technician field workflow — capture the customer's on-site e-signature.
 *
 * Accepts a multipart upload of the canvas-exported PNG plus the customer's
 * printed name. Validates the file via r2-client (jpeg/png only — a canvas
 * exports PNG, so the allowlist is NOT broadened), uploads to R2, then records
 * the URL + name + signedAt on the job. The assignee + tenant guard lives in
 * recordSignature; we also verify ownership BEFORE uploading so an unauthorized
 * caller can't write to storage.
 *
 * PII: signatureName is the customer's printed name — it MUST NOT be logged.
 */
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { recordSignature } from "@/lib/tech/field-queries";
import {
  getStorageClient,
  generateStorageKey,
  MAX_FILE_SIZE,
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
      `tech:signature:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;

    const formData = await request.formData();
    const file = formData.get("file");
    const signatureName = (formData.get("signatureName") as string | null)?.trim();

    if (!(file instanceof File)) {
      return errorResponse("Signature image is required", "INVALID_INPUT", 400);
    }
    if (!signatureName || signatureName.length > 200) {
      return errorResponse("Signature name is required", "INVALID_INPUT", 400);
    }

    const storageClient = getStorageClient();
    const validatedMime = storageClient.validateFile(file, MAX_FILE_SIZE);
    if (!validatedMime) {
      return errorResponse(
        "Invalid file. Only JPEG and PNG images are allowed.",
        "INVALID_INPUT",
        400,
      );
    }

    // Verify ownership BEFORE uploading so a non-assignee can't write to storage.
    // recordSignature re-checks under tenant scope; this is the pre-upload gate.
    const storageKey = generateStorageKey(session.organizationId, id, file.name);
    const uploadResult = await storageClient.uploadFile(
      file,
      storageKey,
      validatedMime,
    );

    const result = await recordSignature(
      session.organizationId,
      session.userId,
      id,
      { signatureUrl: uploadResult.url, signatureName },
    );
    if (!result.ok) {
      // Not assigned to this tech: clean up the orphaned upload, then 404. We do
      // not pre-check ownership against a separate read to keep the guard in one
      // authoritative place (recordSignature).
      await storageClient.deleteFile(storageKey).catch(() => {});
      return errorResponse(
        "Job not found or not assigned to you",
        "NOT_FOUND",
        404,
      );
    }

    // PII: never log signatureName.
    logger.info(
      { serviceRequestId: id, technicianId: session.userId },
      "Technician captured customer signature",
    );
    return successResponse({ signed: true }, 201);
  } catch (error) {
    logger.error({ error }, "Failed to capture signature");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
