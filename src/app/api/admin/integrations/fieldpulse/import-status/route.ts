import { getAdminSession } from "@/lib/auth/session";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { db } from "@/lib/db";
import { fpImportRuns } from "@/lib/db/schema";
import { eq, desc } from "drizzle-orm";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const rateCheck = slidingWindow(
      `admin:fp-import-status:${session.userId}`,
      RATE_LIMITS.adminRead.maxRequests,
      RATE_LIMITS.adminRead.windowMs,
    );
    if (!rateCheck.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const runs = await db
      .select()
      .from(fpImportRuns)
      .where(eq(fpImportRuns.organizationId, session.organizationId))
      .orderBy(desc(fpImportRuns.startedAt))
      .limit(25);

    // Serialize dates as ISO strings for the client.
    const serialized = runs.map((r) => ({
      ...r,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    }));

    return successResponse({ runs: serialized });
  } catch (error: unknown) {
    logger.error({ error }, "Failed to load FP import status");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
