import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getCustomers, createCustomer } from "@/lib/admin/crm-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
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

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const result = await getCustomers(session.organizationId);
    return successResponse({ customers: result });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to fetch customers");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const body = (await request.json()) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!name) {
      return errorResponse("Name is required", "VALIDATION_ERROR", 400);
    }

    const customer = await createCustomer(session.organizationId, {
      name,
      phone: typeof body.phone === "string" ? body.phone : undefined,
      email: typeof body.email === "string" ? body.email : undefined,
      address: typeof body.address === "string" ? body.address : undefined,
      propertyType:
        typeof body.propertyType === "string" ? body.propertyType : undefined,
      propertySqft:
        typeof body.propertySqft === "number" ? body.propertySqft : undefined,
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
    if (isUniqueViolation(error)) {
      return errorResponse(
        "A customer with this email or phone already exists",
        "CUSTOMER_ALREADY_EXISTS",
        409,
      );
    }
    logger.error({ error }, "Failed to create customer");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
