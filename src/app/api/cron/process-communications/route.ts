/**
 * Vercel Cron Job: Process Communication Queue
 *
 * Processes pending communication jobs (SMS and email).
 *
 * SCHEDULE — two callers, on purpose:
 *  - `.github/workflows/sub-daily-crons.yml` pings it on a five-minute cron
 *    expression. GitHub throttles that hard; measured delivery is ~hourly, not
 *    5-minutely. This is the primary driver.
 *  - `vercel.json` runs it daily (`0 5 * * *`) as an outage backstop for when
 *    Actions is down, disabled, or the shared secret drifts.
 *
 * Do NOT "restore" a `* * * * *` schedule in vercel.json: sub-daily crons are
 * rejected at deploy time on the Hobby plan, so it would break the next deploy.
 *
 * SIZING CAVEAT — one invocation drains at most 10 pending + 5 retries. At the
 * ~hourly Actions cadence that keeps up with normal volume, but it means the
 * daily Vercel backstop alone releases ≤10 messages per day. So the backstop
 * proves the queue is still being served; it does NOT drain a real backlog. If
 * Actions is down for a day, expect to drain manually rather than to wait.
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
