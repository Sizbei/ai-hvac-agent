import { NextRequest } from "next/server";
import { getViewerContext } from "@/lib/auth/viewer";
import {
  getCustomers,
  createCustomer,
  findNativeContactClash,
} from "@/lib/admin/crm-queries";
import { phoneInputError } from "@/lib/admin/customer-validation";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import type { Visibility } from "@/lib/admin/visibility";
import { logger } from "@/lib/logger";

export async function GET(request: NextRequest) {
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

    const rateCheck = slidingWindow(
      `admin:customers-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const params = request.nextUrl.searchParams;
    const includeArchived = params.get("includeArchived") === "true";
    const pageRaw = Number(params.get("page"));
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
    const search = params.get("search") ?? "";
    const propertyType = params.get("propertyType");
    const customerType = params.get("customerType");
    const membershipStatus = params.get("membershipStatus");
    const fieldpulseSynced = params.get("fieldpulseSynced") === "true";

    const result = await getCustomers(session.organizationId, {
      includeArchived,
      page,
      search,
      propertyType,
      customerType,
      membershipStatus,
      fieldpulseSynced,
    }, viewer);
    const response = successResponse(result);
    // no-store: the list (and its search) reflects edits, archive and unarchive
    // at once. A browser-cached body would show pre-edit results and the hook
    // never refetches to correct them.
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch customers");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  let organizationId: string | null = null;
  let clash: { email: string | null; phone: string | null } | null = null;
  let vis: Visibility | null = null;
  try {
    const viewer = await getViewerContext();
    if (!viewer) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }
    const { session } = viewer;

    organizationId = session.organizationId;
    vis = viewer;
    const rateCheck = slidingWindow(
      `admin:customers-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const bodyResult = await readJsonBody(request);
    if (!bodyResult.ok) {
      return errorResponse("Invalid JSON body", "VALIDATION_ERROR", 400);
    }
    const body = bodyResult.data as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!name) {
      return errorResponse("Name is required", "VALIDATION_ERROR", 400);
    }
    if (name.length > 200) {
      return errorResponse("Name must be 200 characters or fewer", "VALIDATION_ERROR", 400);
    }

    const phone = typeof body.phone === "string" ? body.phone : undefined;
    const email = typeof body.email === "string" ? body.email : undefined;
    const phoneError = phoneInputError(phone);
    if (phoneError) {
      return errorResponse(phoneError, "VALIDATION_ERROR", 400);
    }
    clash = { email: email ?? null, phone: phone ?? null };

    const rawSqft = body.propertySqft;
    const propertySqft =
      typeof rawSqft === "number" &&
      Number.isFinite(rawSqft) &&
      rawSqft >= 0 &&
      rawSqft <= 100_000_000
        ? Math.floor(rawSqft)
        : undefined;

    const customer = await createCustomer(session.organizationId, {
      name,
      phone,
      email,
      address: typeof body.address === "string" ? body.address : undefined,
      propertyType:
        typeof body.propertyType === "string" ? body.propertyType : undefined,
      propertySqft,
      notes: typeof body.notes === "string" ? body.notes : undefined,
    });

    // Non-repudiation: record who created the customer (T-03-09). Best-effort —
    // a failed audit insert must not roll back the customer the admin just made.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_customer",
      entity: "customer",
      entityId: customer.id,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, customerId: customer.id },
        "Failed to write audit log for customer creation",
      );
    });

    return successResponse(customer, 201);
  } catch (error: unknown) {
    // A unique-index conflict means a customer with this email or phone already
    // exists in the org — report it as a clean 409 instead of a 500.
    // The details carry the existing row's id + archived flag (no PII) so the
    // form can link to it — an archived match is otherwise unfindable. A clash
    // with a customer the viewer can't see (hidden history) gets the generic
    // copy with no link: the lookup skips hidden rows for an org user.
    if (isUniqueViolation(error)) {
      const existing =
        organizationId && clash && vis
          ? await findNativeContactClash(organizationId, clash, vis).catch(() => null)
          : null;
      return errorResponse(
        existing?.archived
          ? "An archived customer already uses this email or phone"
          : "A customer with this email or phone already exists",
        "CUSTOMER_ALREADY_EXISTS",
        409,
        existing ? { customerId: existing.id, archived: existing.archived } : undefined,
      );
    }
    logger.error({ error }, "Failed to create customer");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
