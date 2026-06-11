/**
 * Manual Communication Trigger
 *
 * API endpoint to manually trigger a communication job.
 * Useful for testing and one-off notifications.
 */

import { queueCommunicationJob } from "@/lib/communication/job-queue";
import { getAdminSession } from "@/lib/auth/session";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

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

    // Parse and validate request body
    const body = await request.json();
    const validated = sendCommunicationSchema.parse(body);

    // For Phase 1, we'll use a default template ID
    // In Phase 2, this will look up the org's active template for the trigger type
    const templateId = "default-template-id"; // TODO: Look up from org's templates

    // Queue the job
    const jobId = await queueCommunicationJob({
      organizationId: session.organizationId,
      templateId,
      triggerType: validated.triggerType,
      channel: validated.channel as any, // PgEnum type issue with zod
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

    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    );
  }
}
