import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/logger";

// Always run fresh against the live DB; never cache a health probe.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface HealthBody {
  readonly status: "ok" | "degraded";
  readonly database: "up" | "down";
}

/**
 * Public, unauthenticated liveness/readiness probe.
 *
 * Returns 200 when the app can reach its database, 503 otherwise — so uptime
 * monitors, load balancers, and post-deploy checks have a single cheap endpoint
 * to hit. It pings the DB with `select 1` rather than reading any table, so it
 * never touches customer data and stays PII-free.
 *
 * Intentionally reveals nothing beyond up/down (no version, no env, no error
 * detail) to avoid leaking deployment internals to anonymous callers.
 */
export async function GET(): Promise<NextResponse<HealthBody>> {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ status: "ok", database: "up" }, { status: 200 });
  } catch (error: unknown) {
    logger.error({ err: error }, "Health check failed: database unreachable");
    return NextResponse.json(
      { status: "degraded", database: "down" },
      { status: 503 },
    );
  }
}
