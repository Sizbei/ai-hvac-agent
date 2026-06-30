/**
 * Stage 7 — technician field view: "my jobs".
 *
 * Lists the active service requests assigned to the calling technician, with the
 * address decrypted (the tech needs it to drive there). Reuses the JWT admin
 * session (technician role). Tenant-scoped to the tech's org.
 */
import { and, eq, inArray, asc } from "drizzle-orm";
import { getTechSession } from "@/lib/auth/tech-session";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { decrypt } from "@/lib/crypto";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const ACTIVE_STATUSES = ["scheduled", "assigned", "in_progress", "on_hold"] as const;

function safeDecrypt(v: string | null): string | null {
  if (!v) return null;
  try {
    return decrypt(v);
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rows = await db
      .select({
        id: serviceRequests.id,
        referenceNumber: serviceRequests.referenceNumber,
        status: serviceRequests.status,
        issueType: serviceRequests.issueType,
        urgency: serviceRequests.urgency,
        description: serviceRequests.description,
        scheduledDate: serviceRequests.scheduledDate,
        arrivalWindowStart: serviceRequests.arrivalWindowStart,
        arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
        addressEncrypted: serviceRequests.addressEncrypted,
        customerNameEncrypted: serviceRequests.customerNameEncrypted,
        accessNotes: serviceRequests.accessNotes,
      })
      .from(serviceRequests)
      .where(
        withTenant(
          serviceRequests,
          session.organizationId,
          and(
            eq(serviceRequests.assignedTo, session.userId),
            inArray(serviceRequests.status, [...ACTIVE_STATUSES]),
          )!,
        ),
      )
      .orderBy(asc(serviceRequests.arrivalWindowStart));

    const jobs = rows.map((r) => ({
      id: r.id,
      referenceNumber: r.referenceNumber,
      status: r.status,
      issueType: r.issueType,
      urgency: r.urgency,
      description: r.description,
      scheduledDate: r.scheduledDate?.toISOString() ?? null,
      arrivalWindowStart: r.arrivalWindowStart?.toISOString() ?? null,
      arrivalWindowEnd: r.arrivalWindowEnd?.toISOString() ?? null,
      address: safeDecrypt(r.addressEncrypted),
      customerName: safeDecrypt(r.customerNameEncrypted),
      accessNotes: r.accessNotes,
    }));

    return successResponse({ jobs });
  } catch (error) {
    logger.error({ error }, "Failed to load technician jobs");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
