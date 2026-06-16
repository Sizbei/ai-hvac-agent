/**
 * Vercel Cron Job: Process Communication Queue
 *
 * This endpoint is called by Vercel Cron every minute to process
 * pending communication jobs (SMS and email).
 *
 * CRON: * * * * * (every minute)
 */

import { processPendingJobs, retryFailedJobs } from "@/lib/communication/job-queue";
import { verifyCronAuth } from "@/lib/cron-auth";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
// nodejs runtime: verifyCronAuth uses node:crypto (timing-safe), unavailable on
// edge; the queue also drives the Twilio/Resend SDKs.
export const runtime = "nodejs";

/**
 * GET /api/cron/process-communications
 *
 * Called by Vercel Cron to process pending communication jobs.
 */
export async function GET(request: Request) {
  // Authenticate via the Bearer CRON_SECRET Vercel injects — a spoofable
  // User-Agent is NOT authentication.
  if (!verifyCronAuth(request.headers.get("authorization"))) {
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
