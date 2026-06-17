import { getAdminSession } from "@/lib/auth/session";
import { getAttachmentForDownload } from "@/lib/admin/attachment-queries";
import { getStorageClient } from "@/lib/storage/r2-client";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/admin/attachments/[id]/download
 *
 * Returns a short-lived signed read URL for an attachment, but ONLY after
 * verifying the admin's organization owns it. The raw R2 key/credentials are
 * never exposed; the client receives an expiring HTTPS URL it can fetch
 * directly. We return the URL as JSON (rather than a 302) so the admin UI can
 * decide whether to open it in a new tab or render a thumbnail.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const { id } = await params;
    if (!UUID_REGEX.test(id)) {
      return errorResponse("Invalid attachment ID format", "INVALID_ID", 400);
    }

    const rateCheck = slidingWindow(
      `admin:attachment-download:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    // Ownership check: returns null when the attachment is not in this org.
    const attachment = await getAttachmentForDownload(
      session.organizationId,
      id,
    );
    if (!attachment) {
      return errorResponse("Attachment not found", "NOT_FOUND", 404);
    }

    const url = await getStorageClient().getSignedReadUrl(
      attachment.storageKey,
    );

    return successResponse({
      url,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to sign attachment download URL");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
