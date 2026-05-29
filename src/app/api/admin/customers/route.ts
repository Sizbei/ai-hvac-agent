import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { getCustomers, createCustomer } from "@/lib/admin/crm-queries";
import { successResponse, errorResponse } from "@/lib/api-response";
import { logger } from "@/lib/logger";

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

    return successResponse(customer, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create customer");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
