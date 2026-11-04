import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import {
  getInvoiceDetailById,
  getInvoiceOrgIdentity,
  listInvoiceReminders,
  type SignatureView,
} from "@/lib/admin/invoice-queries";
import { getStorageClient } from "@/lib/storage/r2-client";
import { storageKeyFromPublicUrl } from "@/lib/storage/storage-key";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { isUuid } from "@/lib/validation/uuid";

const SIGNATURE_URL_TTL_SECONDS = 15 * 60;

type SignatureState = "none" | "present" | "erased" | "unavailable";

/**
 * Swap a stored public signature URL for a 15-minute signed read URL. The
 * caller has already tenant-scoped the invoice. Storage failures (no R2 env —
 * the client constructor throws — or a signing error) degrade to
 * `unavailable`, never a 500.
 */
async function signSignature(
  s: SignatureView,
): Promise<SignatureView & { state: SignatureState }> {
  if (!s.url) {
    return { ...s, url: null, state: s.signedAt ? "erased" : "none" };
  }
  const key = storageKeyFromPublicUrl(s.url);
  if (!key) return { ...s, url: null, state: "unavailable" };
  try {
    const url = await getStorageClient().getSignedReadUrl(key, SIGNATURE_URL_TTL_SECONDS);
    return { ...s, url, state: "present" };
  } catch (error) {
    logger.warn({ error }, "Signature read URL unavailable");
    return { ...s, url: null, state: "unavailable" };
  }
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:invoice-detail:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await context.params;
    if (!isUuid(id)) {
      return errorResponse("Not found", "NOT_FOUND", 404);
    }
    const [invoice, org, reminders] = await Promise.all([
      getInvoiceDetailById(session.organizationId, id),
      getInvoiceOrgIdentity(session.organizationId),
      listInvoiceReminders(session.organizationId, id),
    ]);
    if (!invoice) {
      return errorResponse("Invoice not found", "NOT_FOUND", 404);
    }
    const [signature, requestSignature] = await Promise.all([
      signSignature(invoice.signature),
      invoice.requestSignature ? signSignature(invoice.requestSignature) : null,
    ]);
    return successResponse({
      invoice: { ...invoice, signature, requestSignature },
      org,
      reminders,
    });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch invoice detail");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
