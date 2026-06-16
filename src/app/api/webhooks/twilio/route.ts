/**
 * Twilio Webhook Handler
 *
 * Handles delivery status updates from Twilio for SMS messages.
 * Updates communication_jobs with final delivery status.
 */

import { db } from "@/lib/db";
import { communicationJobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { parseWebhookEvent } from "@/lib/communication/twilio-adapter";
import { parseAndVerifyTwilioRequest } from "@/lib/voice/request";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/webhooks/twilio
 *
 * Receives delivery status updates from Twilio.
 */
export async function POST(request: NextRequest) {
  try {
    // Verify the Twilio signature with the real algorithm (sorted params +
    // forwarded public URL) and read the form params. Fails closed.
    const { params, valid } = await parseAndVerifyTwilioRequest(request);
    if (!valid) {
      console.warn("Twilio webhook signature verification failed");
      return new NextResponse("Invalid signature", { status: 403 });
    }

    const webhookEvent = parseWebhookEvent(params);

    // Find the communication job by external ID
    const job = await db.query.communicationJobs.findFirst({
      where: eq(communicationJobs.externalId, webhookEvent.MessageSid),
    });

    if (!job) {
      console.warn(`Communication job not found for Twilio message ${webhookEvent.MessageSid}`);
      return new NextResponse("Job not found", { status: 404 });
    }

    // Map Twilio status to our job status
    const statusMap: Record<string, "sent" | "failed"> = {
      queued: "sent",
      sent: "sent",
      delivered: "sent",
      undelivered: "failed",
      failed: "failed",
    };

    const newStatus = statusMap[webhookEvent.MessageStatus];
    if (!newStatus) {
      console.log(`Unhandled Twilio status: ${webhookEvent.MessageStatus}`);
      return new NextResponse("Status not handled", { status: 200 });
    }

    // Update job status
    await db
      .update(communicationJobs)
      .set({
        status: newStatus,
        completedAt: newStatus === "failed" ? new Date() : job.completedAt,
        errorMessage: webhookEvent.ErrorMessage,
      })
      .where(eq(communicationJobs.id, job.id));

    return new NextResponse("OK", { status: 200 });
  } catch (error) {
    console.error("Twilio webhook error:", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
