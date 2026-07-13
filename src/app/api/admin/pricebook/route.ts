import { NextRequest } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import {
  listPricebookItemsForAdmin,
  createPricebookItem,
  type PricebookSortKey,
} from "@/lib/admin/pricebook-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/** Postgres unique-violation SQLSTATE. */
const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

const itemSchema = z.object({
  categoryId: z.string().uuid().nullable().optional(),
  type: z.enum(["service", "material", "equipment"]),
  name: z.string().trim().min(1).max(255),
  description: z.string().optional(),
  sku: z.string().optional(),
  costCents: z.number().int().min(0).default(0),
  markupPct: z.number().int().min(0).default(0),
  priceCents: z.number().int().min(0),
  memberPriceCents: z.number().int().min(0).nullable().optional(),
  hours: z.number().int().min(0).nullable().optional(),
  warranty: z.string().optional(),
});

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:pricebook-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const sp = request.nextUrl.searchParams;
    const includeInactive = sp.get("includeInactive") === "true";
    const isLaborItem = sp.get("isLaborItem") === "true";

    const rawPage = Number(sp.get("page") ?? "1");
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

    const rawLimit = Number(sp.get("limit") ?? "50");
    const limit = Number.isFinite(rawLimit) ? Math.min(20000, Math.max(1, Math.floor(rawLimit))) : 50;

    const search = sp.get("search") ?? undefined;

    const VALID_TYPES = ["service", "material", "equipment"] as const;
    const rawType = sp.get("type") ?? undefined;
    const type = rawType !== undefined && (VALID_TYPES as readonly string[]).includes(rawType)
      ? rawType
      : undefined;

    const VALID_SORT_KEYS: ReadonlyArray<PricebookSortKey> = ['name', 'price_asc', 'price_desc'];
    const rawSort = sp.get("sort") ?? undefined;
    const sort = rawSort !== undefined && (VALID_SORT_KEYS as readonly string[]).includes(rawSort)
      ? (rawSort as PricebookSortKey)
      : undefined;

    const { items, total, types } = await listPricebookItemsForAdmin(
      session.organizationId,
      { includeInactive, isLaborItem, page, limit, search, type, sort },
    );
    return successResponse({ items, total, types });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch pricebook items");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:pricebook-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const parsed = itemSchema.safeParse(await request.json());
    if (!parsed.success) {
      return errorResponse("Invalid pricebook item", "VALIDATION_ERROR", 400);
    }

    const id = await createPricebookItem(session.organizationId, parsed.data);

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_pricebook_item",
      entity: "pricebook_item",
      entityId: id,
      details: `type=${parsed.data.type};priceCents=${parsed.data.priceCents}`,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, itemId: id },
        "Failed to write audit log for pricebook item creation",
      );
    });

    return successResponse({ id }, 201);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return errorResponse(
        "An item with this SKU already exists",
        "ITEM_ALREADY_EXISTS",
        409,
      );
    }
    logger.error({ error }, "Failed to create pricebook item");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
