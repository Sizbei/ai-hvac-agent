/**
 * Manual Communication Trigger
 *
 * API endpoint to manually trigger a communication job.
 * Useful for testing and one-off notifications.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { queueCommunicationJob } from "@/lib/communication/job-queue";
import { getAdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { communicationTemplates } from "@/lib/db/schema";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

// Validation schema
const sendCommunicationSchema = z.object({
  triggerType: z.enum([
    "appointment_scheduled",
    "appointment_reminder_24h",
    "appointment_reminder_2h",
    "appointment_rescheduled",
    "appointment_cancelled",
    "technician_enroute",
    "technician_arrived",
    "job_completed",
    "review_request",
    "follow_up",
    "escalation",
  ]),
  channel: z.enum(["sms", "email"]),
  recipientPhone: z.string().optional(),
  recipientEmail: z.string().optional(),
  templateVariables: z.record(z.string(), z.any()),
  scheduledFor: z.string().datetime().optional(),
  priority: z.number().min(0).max(100).optional(),
  customerId: z.string().uuid().optional(),
  serviceRequestId: z.string().uuid().optional(),
});

/**
 * POST /api/communications/send
 *
 * Manually queue a communication job.
 */
export async function POST(request: NextRequest) {
  try {
    // Verify admin session
    const session = await getAdminSession();
    if (!session) {
      return new NextResponse("Unauthorized", { status: 401 });
    }

    // This endpoint enqueues outbound SMS/email — rate-limit it so a leaked
    // session can't be used to blast messages.
    const rateCheck = slidingWindow(
      `comms-send:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return NextResponse.json(
        { success: false, error: "Rate limit exceeded" },
        { status: 429 },
      );
    }

    // Parse and validate request body
    const body = await request.json();
    const validated = sendCommunicationSchema.parse(body);

    // Resolve the org's active template for this trigger + channel. SMS maps to
    // the 'sms' template type; email maps to either html or text (pick by
    // priority, lowest number first). Without this, we'd enqueue a job that
    // always fails deep in the queue with "Template not found".
    const templateTypes =
      validated.channel === "sms"
        ? (["sms"] as const)
        : (["email_html", "email_text"] as const);
    const template = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.organizationId, session.organizationId),
        eq(communicationTemplates.triggerType, validated.triggerType),
        inArray(communicationTemplates.templateType, [...templateTypes]),
        eq(communicationTemplates.isActive, true),
      ),
      orderBy: [asc(communicationTemplates.priority)],
    });
    if (!template) {
      return NextResponse.json(
        {
          success: false,
          error: `No active ${validated.channel} template configured for "${validated.triggerType}"`,
        },
        { status: 400 },
      );
    }
    const templateId = template.id;

    // Queue the job
    const jobId = await queueCommunicationJob({
      organizationId: session.organizationId,
      templateId,
      triggerType: validated.triggerType,
      channel: validated.channel,
      recipientPhone: validated.recipientPhone,
      recipientEmail: validated.recipientEmail,
      templateVariables: validated.templateVariables,
      scheduledFor: validated.scheduledFor
        ? new Date(validated.scheduledFor)
        : undefined,
      priority: validated.priority,
      customerId: validated.customerId,
      serviceRequestId: validated.serviceRequestId,
    });

    return NextResponse.json({
      success: true,
      jobId,
      message: "Communication job queued successfully",
    });
  } catch (error) {
    console.error("Failed to queue communication:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: "Invalid request body", details: error.issues },
        { status: 400 },
      );
    }

    // Never forward the raw error message to the client (leaks internals).
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 },
    );
  }
}
