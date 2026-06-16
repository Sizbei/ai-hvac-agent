/**
 * POST /api/financing/webhook — lender status callback (mock-first).
 *
 * A provider/lender reports an application's status change here. There is no
 * admin session — it's an unauthenticated provider callback — so it authenticates
 * with a shared secret (FINANCING_WEBHOOK_SECRET) and FAILS CLOSED when the
 * secret is unset (same posture as the Resend webhook).
 *
 * Mock until a real lender contract exists: payload shape is our own. The org is
 * resolved from the application row (keyed by providerAppId), never trusted from
 * the payload, then the status is mirrored idempotently (tenant-scoped).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { financingApplications } from "@/lib/db/schema";
import { updateFinancingStatusByProviderId } from "@/lib/admin/financing-queries";
import { timingSafeStrEqual } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const payloadSchema = z.object({
  providerAppId: z.string().min(1),
  status: z.enum(["pending", "approved", "declined", "expired"]),
});

export async function POST(request: NextRequest) {
  try {
    // Fail closed: no secret configured -> reject (never accept unauthenticated).
    const expected = process.env.FINANCING_WEBHOOK_SECRET?.trim();
    if (!expected) {
      logger.error("Financing webhook rejected: FINANCING_WEBHOOK_SECRET unset");
      return new NextResponse("Not configured", { status: 503 });
    }

    const provided = request.headers.get("x-financing-secret");
    if (!provided || !timingSafeStrEqual(provided, expected)) {
      return new NextResponse("Invalid signature", { status: 401 });
    }

    const parsed = payloadSchema.safeParse(await request.json());
    if (!parsed.success) {
      return new NextResponse("Invalid payload", { status: 400 });
    }
    const { providerAppId, status } = parsed.data;

    // Resolve the org from the application row — never trust it from the payload.
    const [row] = await db
      .select({ organizationId: financingApplications.organizationId })
      .from(financingApplications)
      .where(eq(financingApplications.providerAppId, providerAppId))
      .limit(1);
    if (!row) {
      return new NextResponse("Unknown application", { status: 404 });
    }

    await updateFinancingStatusByProviderId(
      row.organizationId,
      providerAppId,
      status,
    );

    return new NextResponse("OK", { status: 200 });
  } catch (error: unknown) {
    logger.error({ error }, "Financing webhook error");
    return new NextResponse("Internal error", { status: 500 });
  }
}
