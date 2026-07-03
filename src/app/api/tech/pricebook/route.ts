/**
 * GET /api/tech/pricebook — active catalog items for the technician material-add
 * UI. Tech session only, org-scoped. Returns just id/name/type/priceCents (NOT
 * the admin projection's cost/markup internals). The client previously hit
 * /api/admin/pricebook, which always 401s for a tech session, so catalog
 * materials could never be added.
 */
import { getTechSession } from "@/lib/auth/tech-session";
import { listPricebookItemsForAdmin } from "@/lib/admin/pricebook-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const rows = await listPricebookItemsForAdmin(session.organizationId, {
      includeInactive: false,
    });
    // Only physical goods (material / equipment) belong in the job-material
    // picker. 'service' items are labor line items priced very differently —
    // exposing them here let a tech book a service-priced row as a material.
    const items = rows
      .filter((i) => i.type === "material" || i.type === "equipment")
      .map((i) => ({
        id: i.id,
        name: i.name,
        type: i.type,
        priceCents: i.priceCents,
      }));
    return successResponse({ items });
  } catch (error) {
    logger.error({ error }, "Failed to load tech pricebook");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
