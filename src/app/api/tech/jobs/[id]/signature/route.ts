/**
 * Technician field workflow — capture the customer's on-site e-signature.
 *
 * Accepts a multipart upload of the canvas-exported PNG plus the customer's
 * printed name. Order (spec §6.5): session → same-origin → UUID → rate →
 * readable → native → active lead → body → Idempotency-Key claim (hash of the
 * file bytes + name) BEFORE the upload → upload → recordSignature. The client
 * holds one Blob + key per intent, so a retry replays instead of uploading a
 * second object. File validation is r2-client's jpeg/png allowlist (a canvas
 * exports PNG, so it is NOT broadened). The replaced object is deleted in
 * after() unless an invoice snapshot still references it.
 *
 * PII: signatureName is the customer's printed name — it MUST NOT be logged.
 */
import { after, type NextRequest } from "next/server";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getTechSession } from "@/lib/auth/tech-session";
import { isSameOriginRequest } from "@/lib/session-csrf";
import { isUuid } from "@/lib/validation/uuid";
import { recordSignature } from "@/lib/tech/field-queries";
import {
  getStorageClient,
  generateStorageKey,
  MAX_FILE_SIZE,
} from "@/lib/storage/r2-client";
import { storageKeyFromPublicUrl } from "@/lib/storage/storage-key";
import { findActiveVisit, findReadableJob } from "@/lib/tech/ownership";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorResponse } from "@/lib/api-response";
import { multipartHash, parseIdempotencyKey, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { logAudit } from "@/lib/admin/audit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Delete a replaced signature object unless an invoice snapshot references it. */
async function deleteReplacedSignature(organizationId: string, oldUrl: string): Promise<void> {
  const storageKey = storageKeyFromPublicUrl(oldUrl);
  if (!storageKey) return;
  const { rows } = (await db.execute(sql`SELECT EXISTS (SELECT 1 FROM invoices WHERE organization_id = ${organizationId}::uuid AND signature_url = ${oldUrl}) AS referenced`)) as unknown as { rows: { referenced: boolean }[] };
  if (rows[0]?.referenced) return;
  await getStorageClient().deleteFile(storageKey);
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
    if (!isSameOriginRequest(request)) {
      return errorResponse("Forbidden", "FORBIDDEN", 403);
    }
    const { id } = await params;
    if (!isUuid(id)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }
    const rate = slidingWindow(
      `tech:signature:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rate.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }
    const { organizationId, userId } = session;

    // Ownership, native and lead BEFORE anything touches storage.
    const job = await findReadableJob(organizationId, userId, id);
    if (!job) {
      return errorResponse("This job isn't yours.", "NOT_FOUND", 404);
    }
    if (!job.native) {
      return errorResponse("This job is managed in FieldPulse.", "MANAGED_EXTERNALLY", 409);
    }
    // Only the active visit's lead may capture the signature; recordSignature
    // re-asserts a lead row in the write itself.
    const active = await findActiveVisit(organizationId, id);
    if (active?.leadTechnicianId !== userId) {
      return errorResponse("Only the lead technician can do that.", "NOT_LEAD", 403);
    }

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

    const key = parseIdempotencyKey(request.headers.get("idempotency-key"));
    if (!key) {
      return errorResponse("Missing idempotency key.", "IDEMPOTENCY_KEY_REQUIRED", 400);
    }
    const route = request.nextUrl.pathname;
    const fileSha256 = createHash("sha256").update(new Uint8Array(await file.arrayBuffer())).digest("hex");

    let previousUrl: string | null = null;
    const result = await withIdempotency(
      { organizationId, userId, route, key },
      multipartHash({ route, requestId: id, fileSha256, name: signatureName }),
      async () => {
        const storageKey = generateStorageKey(organizationId, id, file.name);
        const upload = await storageClient.uploadFile(file, storageKey, validatedMime);
        const recorded = await recordSignature(organizationId, userId, id, {
          signatureUrl: upload.url,
          signatureName,
        });
        if (!recorded.ok) {
          // Race: job was reassigned between the ownership check and the write.
          await storageClient.deleteFile(storageKey).catch(() => {});
          return {
            status: 404,
            envelope: { success: false, error: { message: "Job not found or not assigned to you", code: "NOT_FOUND" } },
          };
        }
        if (recorded.previousUrl && recorded.previousUrl !== upload.url) previousUrl = recorded.previousUrl;
        return { status: 201, envelope: { success: true, data: { signed: true } } };
      },
    );

    if (result.status === 201 && !result.replayed) {
      const oldUrl = previousUrl;
      if (oldUrl) {
        after(async () => {
          try {
            await deleteReplacedSignature(organizationId, oldUrl);
          } catch (error) {
            logger.error({ error, serviceRequestId: id }, "Failed to delete replaced signature");
          }
        });
      }
      try {
        await logAudit({
          organizationId,
          userId,
          action: "signature_recorded",
          entity: "service_request",
          entityId: id,
          details: `requestId:${id}`,
        });
      } catch (error) {
        logger.error({ error, serviceRequestId: id }, "Signature audit failed");
      }
      // PII: never log signatureName.
      logger.info(
        { serviceRequestId: id, technicianId: userId },
        "Technician captured customer signature",
      );
    }
    return toResponse(result);
  } catch (error) {
    logger.error({ error }, "Failed to capture signature");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
