/**
 * Resend Webhook Handler
 *
 * Handles delivery status updates from Resend for emails.
 * Updates communication_jobs with final delivery status.
 */

import { db } from "@/lib/db";
import { communicationJobs } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { parseWebhookEvent, validateWebhookSignature } from "@/lib/communication/resend-adapter";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/webhooks/resend
 *
 * Receives delivery status updates from Resend.
 */
export async function POST(request: NextRequest) {
  try {
    // Get the raw body for signature validation
    const rawBody = await request.text();

    // Validate signature
    const signature = request.headers.get("resend-signature");
    if (!signature) {
      console.warn("Resend webhook missing signature");
      return new NextResponse("Missing signature", { status: 401 });
    }

    if (!validateWebhookSignature(signature, rawBody)) {
      console.error("Resend webhook signature validation failed");
      return new NextResponse("Invalid signature", { status: 403 });
    }

    // Parse event
    const event = parseWebhookEvent(JSON.parse(rawBody));

    // Find the communication job by external ID
    const job = await db.query.communicationJobs.findFirst({
      where: eq(communicationJobs.externalId, event.data.email_id),
    });

    if (!job) {
      console.warn(`Communication job not found for Resend email ${event.data.email_id}`);
      return new NextResponse("Job not found", { status: 404 });
    }

    // Map Resend event type to our job status
    const statusMap: Record<string, "sent" | "failed"> = {
      "email.delivery_delayed": "sent",
      "email.delivered": "sent",
      "email.bounced": "failed",
      "email.complained": "sent", // Mark as sent but flag the complaint
    };

    const newStatus = statusMap[event.type];
    if (!newStatus) {
      console.log(`Unhandled Resend event type: ${event.type}`);
      return new NextResponse("Event type not handled", { status: 200 });
    }

    // Update job status
    await db
      .update(communicationJobs)
      .set({
        status: newStatus,
        completedAt: newStatus === "failed" ? new Date() : job.completedAt,
      })
      .where(eq(communicationJobs.id, job.id));

    return new NextResponse("OK", { status: 200 });
  } catch (error) {
    console.error("Resend webhook error:", error);
    return new NextResponse("Internal error", { status: 500 });
  }
}
