/**
 * GET /api/tech/pricebook — active catalog items for the technician material-add
 * UI. Tech session only, org-scoped. Returns just id/name/type/priceCents (NOT
 * the admin projection's cost/markup internals). The client previously hit
 * /api/admin/pricebook, which always 401s for a tech session, so catalog
 * materials could never be added.
 *
 * `?scope=invoice&q=` is the field invoice's add-item search (spec §6.2):
 * active items of EVERY type (services included), server search, q >= 2
 * chars, limit 50, `{ id, name, type, priceCents, sku }`, rate-limited.
 */
import type { NextRequest } from "next/server";
import { getTechSession } from "@/lib/auth/tech-session";
import { listPricebookItemsForAdmin } from "@/lib/admin/pricebook-queries";
import { RATE_LIMITS, slidingWindow } from "@/lib/rate-limit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

const INVOICE_SEARCH_LIMIT = 50;
const INVOICE_SEARCH_MIN_CHARS = 2;

async function invoiceSearch(organizationId: string, userId: string, q: string) {
  const rate = slidingWindow(`tech:pricebook:${userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
  if (!rate.allowed) {
    return errorResponse("Too many requests. Wait a moment and try again.", "RATE_LIMITED", 429);
  }
  const search = q.trim();
  if (search.length < INVOICE_SEARCH_MIN_CHARS) return successResponse({ items: [] });
  const page = await listPricebookItemsForAdmin(organizationId, {
    search,
    includeInactive: false,
    limit: INVOICE_SEARCH_LIMIT,
  });
  const items = page.items.map((i) => ({ id: i.id, name: i.name, type: i.type, priceCents: i.priceCents, sku: i.sku }));
  return successResponse({ items });
}

export async function GET(request: NextRequest) {
  try {
    const session = await getTechSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const params = new URL(request.url).searchParams;
    if (params.get("scope") === "invoice") {
      return await invoiceSearch(session.organizationId, session.userId, params.get("q") ?? "");
    }
    // Fetch all physical goods by type — no pagination needed here since this
    // is a small picker and we filter server-side before returning.
    const TECH_LIMIT = 20000;
    const VALID_TYPES = ["material", "equipment"] as const;
    const [materialPage, equipmentPage] = await Promise.all([
      listPricebookItemsForAdmin(session.organizationId, {
        includeInactive: false,
        type: VALID_TYPES[0],
        limit: TECH_LIMIT,
      }),
      listPricebookItemsForAdmin(session.organizationId, {
        includeInactive: false,
        type: VALID_TYPES[1],
        limit: TECH_LIMIT,
      }),
    ]);
    // Warn if either result was truncated (hit the limit).
    if (materialPage.items.length === TECH_LIMIT) {
      logger.warn({ orgId: session.organizationId, type: "material" }, "Tech pricebook material result hit limit — catalog may be truncated");
    }
    if (equipmentPage.items.length === TECH_LIMIT) {
      logger.warn({ orgId: session.organizationId, type: "equipment" }, "Tech pricebook equipment result hit limit — catalog may be truncated");
    }
    // Only physical goods (material / equipment) belong in the job-material
    // picker. 'service' items are labor line items priced very differently —
    // exposing them here let a tech book a service-priced row as a material.
    const items = [...materialPage.items, ...equipmentPage.items].map((i) => ({
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
