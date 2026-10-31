import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { customers } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { listContacts, createContact } from "@/lib/admin/contact-queries";
import { contactInputSchema } from "@/lib/admin/contact-types";
import { logAudit } from "@/lib/admin/audit";
import { isUuid } from "@/lib/validation/uuid";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const MAX_CONTACTS = 20;

async function customerExists(organizationId: string, id: string): Promise<boolean> {
  const [customer] = await db
    .select({ id: customers.id })
    .from(customers)
    .where(withTenant(customers, organizationId, eq(customers.id, id)))
    .limit(1);
  return Boolean(customer);
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:customer-contacts:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!isUuid(id) || !(await customerExists(session.organizationId, id))) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    const contacts = await listContacts(session.organizationId, id);
    return successResponse({ contacts });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list customer contacts");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:customer-contact-create:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    if (!isUuid(id) || !(await customerExists(session.organizationId, id))) {
      return errorResponse("Customer not found", "NOT_FOUND", 404);
    }

    const body = await readJsonBody(request);
    if (!body.ok) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }
    const parsed = contactInputSchema.safeParse(body.data);
    if (!parsed.success) {
      return errorResponse(
        "Invalid contact: " + parsed.error.issues[0]?.message,
        "VALIDATION_ERROR",
        400,
      );
    }

    const existing = await listContacts(session.organizationId, id);
    if (existing.length >= MAX_CONTACTS) {
      return errorResponse(
        `A customer can have at most ${MAX_CONTACTS} contacts.`,
        "LIMIT_REACHED",
        409,
      );
    }

    const result = await createContact(session.organizationId, id, parsed.data);
    if ("reason" in result) {
      if (result.reason === "race") {
        return errorResponse("Someone else just changed the primary contact. Reload and try again.", "RACE", 409);
      }
      return errorResponse(
        "That location doesn't belong to this customer.",
        "VALIDATION_ERROR",
        400,
      );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "create_contact",
      entity: "customer_contacts",
      entityId: result.id,
      details: JSON.stringify({ customerId: id }),
    }).catch((auditError: unknown) => {
      logger.error({ error: auditError }, "Failed to audit create_contact");
    });

    return successResponse({ contact: result }, 201);
  } catch (error: unknown) {
    logger.error({ error }, "Failed to create customer contact");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
