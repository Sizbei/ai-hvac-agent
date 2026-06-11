/**
 * Vercel Cron Job: Process Communication Queue
 *
 * This endpoint is called by Vercel Cron every minute to process
 * pending communication jobs (SMS and email).
 *
 * CRON: * * * * * (every minute)
 */

import { processPendingJobs, retryFailedJobs } from "@/lib/communication/job-queue";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "edge";

/**
 * Verify the request is from Vercel Cron
 */
function verifyCronRequest(request: Request): boolean {
  // Vercel Cron adds a specific user agent
  const userAgent = request.headers.get("user-agent");
  return userAgent === "vercel-cron/1.0";
}

/**
 * GET /api/cron/process-communications
 *
 * Called by Vercel Cron to process pending communication jobs.
 */
export async function GET(request: Request) {
  // Verify this is a cron request
  if (!verifyCronRequest(request)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    // Process pending jobs
    const pendingResult = await processPendingJobs(10);

    // Retry failed jobs
    const retried = await retryFailedJobs(5);

    return NextResponse.json({
      success: true,
      pending: pendingResult,
      retried,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Cron job error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
