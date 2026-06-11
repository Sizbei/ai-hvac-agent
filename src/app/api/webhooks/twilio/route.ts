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
    // Get the raw body for signature validation
    const rawBody = await request.text();

    // Parse form data
    const formData = new URLSearchParams(rawBody);
    const event: Record<string, unknown> = {};
    for (const [key, value] of formData.entries()) {
      event[key] = value;
    }

    // Validate signature
    const signature = request.headers.get("X-Twilio-Signature");
    const url = request.url;

    if (!signature) {
      console.warn("Twilio webhook missing signature");
      return new NextResponse("Missing signature", { status: 401 });
    }

    // Parse and validate event
    let webhookEvent;
    try {
      webhookEvent = parseWebhookEvent(event, signature, url);
    } catch (error) {
      console.error("Twilio webhook validation failed:", error);
      return new NextResponse("Invalid signature", { status: 403 });
    }

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
