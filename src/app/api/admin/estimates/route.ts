import { NextRequest, after } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { triggerEstimateSent } from "@/lib/communication/money-triggers";
import {
  listEstimates,
  createEstimate,
  getEstimatePipelineStats,
  type EstimateOptionInput,
} from "@/lib/admin/estimate-queries";
import {
  getDefaultTaxBps,
  getPricebookItemById,
} from "@/lib/admin/pricebook-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { logger } from "@/lib/logger";

// taxBps is intentionally NOT accepted here — it is derived server-side from the
// org's default tax rate so a client cannot quote at a tampered rate.
const createSchema = z.object({
  serviceRequestId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  // When true (and the estimate is linked to a customer with contact info), text
  // the customer the tokenized approval link via the consent-gated comms queue.
  sendToCustomer: z.boolean().optional(),
  options: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        lineItems: z
          .array(
            z.object({
              // A catalog line carries a pricebookItemId; the server re-snapshots
              // its price/cost authoritatively. A manual line omits it and must
              // supply name + unitPriceCents. Client name/price on a catalog line
              // are ignored (anti-tampering).
              pricebookItemId: z.string().uuid().nullable().optional(),
              name: z.string().trim().min(1).max(255).optional(),
              quantity: z.number().int().min(1),
              unitPriceCents: z.number().int().min(0).optional(),
              useMemberPrice: z.boolean().optional(),
            }),
          )
          .min(1),
      }),
    )
    .min(1)
    .max(10),
});

export async function GET(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) {
      return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    }

    const rateCheck = slidingWindow(
      `admin:estimates-list:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const sp = request.nextUrl.searchParams;
    const rawPage = Number(sp.get('page') ?? '1');
    const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
    const rawLimit = Number(sp.get('limit') ?? '50');
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 20000) : 50;
    const customerId = sp.get('customerId') || undefined;
    const serviceRequestId = sp.get('serviceRequestId') || undefined;
    const search = sp.get('search') || undefined;

    // Whitelist bucket — invalid values silently drop to undefined (no 400; the
    // scoped section passes no bucket and must continue to work).
    const VALID_BUCKETS = new Set(['open', 'won', 'lost', 'draft'] as const);
    type ValidBucket = 'open' | 'won' | 'lost' | 'draft';
    const rawBucket = sp.get('bucket');
    const bucket: ValidBucket | undefined =
      rawBucket && VALID_BUCKETS.has(rawBucket as ValidBucket)
        ? (rawBucket as ValidBucket)
        : undefined;

    const [{ estimates, total }, stats] = await Promise.all([
      listEstimates(session.organizationId, { page, limit, customerId, serviceRequestId, bucket, search }),
      getEstimatePipelineStats(session.organizationId),
    ]);
    return successResponse({ estimates, total, stats });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to list estimates");
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
      `admin:estimates-create:${session.userId}`,
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
    const parsed = createSchema.safeParse(bodyResult.data);
    if (!parsed.success) {
      return errorResponse("Invalid estimate", "VALIDATION_ERROR", 400);
    }

    // Resolve every line AUTHORITATIVELY server-side. Catalog lines (those with a
    // pricebookItemId) take name/price/cost from the tenant-scoped pricebook item
    // — a client-sent unitPriceCents can NEVER override a catalog price. Manual
    // lines (no pricebookItemId) require name + price and carry zero cost.
    const resolvedOptions: EstimateOptionInput[] = [];
    for (const opt of parsed.data.options) {
      const resolvedLines: EstimateOptionInput["lineItems"][number][] = [];
      for (const line of opt.lineItems) {
        if (line.pricebookItemId) {
          const item = await getPricebookItemById(
            session.organizationId,
            line.pricebookItemId,
          );
          // Tolerate an item that went inactive (or vanished) between list and
          // submit: clean 400, not a 500.
          if (!item || !item.active) {
            return errorResponse(
              "A selected catalog item is no longer available",
              "VALIDATION_ERROR",
              400,
            );
          }
          const unitPriceCents =
            line.useMemberPrice && item.memberPriceCents != null
              ? item.memberPriceCents
              : item.priceCents;
          resolvedLines.push({
            pricebookItemId: item.id,
            name: item.name, // ignore any client-sent name
            quantity: line.quantity,
            unitPriceCents, // server-derived, never client
            costCents: item.costCents,
          });
        } else {
          // Manual line: must self-describe name + price.
          if (!line.name || line.unitPriceCents == null) {
            return errorResponse(
              "Manual line items need a name and price",
              "VALIDATION_ERROR",
              400,
            );
          }
          resolvedLines.push({
            pricebookItemId: null,
            name: line.name,
            quantity: line.quantity,
            unitPriceCents: line.unitPriceCents,
            costCents: 0,
          });
        }
      }
      resolvedOptions.push({ name: opt.name, lineItems: resolvedLines });
    }

    // Tax is the org's default rate, resolved server-side — never client-supplied.
    const taxBps = await getDefaultTaxBps(session.organizationId);

    const { estimateId, approvalToken } = await createEstimate(
      session.organizationId,
      {
        serviceRequestId: parsed.data.serviceRequestId ?? null,
        customerId: parsed.data.customerId ?? null,
        taxBps,
        options: resolvedOptions,
        expiresInDays: parsed.data.expiresInDays,
      },
    );

    // entityId only — never the one-time approval token (it's the bearer of
    // authority for the public e-sign page) or any customer PII.
    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "estimate_created",
      entity: "estimate",
      entityId: estimateId,
    }).catch((auditError: unknown) => {
      logger.error(
        { error: auditError, estimateId },
        "Failed to write audit log for estimate creation",
      );
    });

    const approvalUrl = `${process.env.NEXT_PUBLIC_APP_URL}/estimates/${approvalToken}`;

    // Optionally send the approval LINK to the customer. The plaintext token is
    // only available here at create time, so we enqueue with the built URL.
    // Best-effort + non-blocking (after()): a comms failure must not fail create.
    if (parsed.data.sendToCustomer && parsed.data.customerId) {
      const orgId = session.organizationId;
      const customerId = parsed.data.customerId;
      after(() =>
        triggerEstimateSent({ organizationId: orgId, customerId, approvalUrl }),
      );
    }

    return successResponse({ estimateId, approvalToken, approvalUrl }, 201);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) {
      return errorResponse(
        "An estimate conflict occurred",
        "ESTIMATE_CONFLICT",
        409,
      );
    }
    logger.error({ error }, "Failed to create estimate");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
