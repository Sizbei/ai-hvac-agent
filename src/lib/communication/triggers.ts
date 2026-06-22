/**
 * Communication Triggers
 *
 * Functions that trigger communications based on service request events.
 * These are called when service requests are created, updated, or completed.
 */

import { queueCommunicationJob } from "./job-queue";
import { communicationTemplates } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";

/**
 * Trigger an appointment scheduled confirmation
 *
 * Called when a service request is scheduled with a technician and time slot.
 *
 * @param params - Appointment details
 */
export async function triggerAppointmentScheduled(params: {
  organizationId: string;
  serviceRequestId: string;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  technicianName: string;
  appointmentDate: Date;
  appointmentTime: string;
  appointmentAddress: string;
  serviceType: string;
  companyName: string;
  phoneNumber: string;
}): Promise<void> {
  // Find the active SMS template for this trigger
  const smsTemplate = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, params.organizationId),
      eq(communicationTemplates.triggerType, "appointment_scheduled"),
      eq(communicationTemplates.templateType, "sms"),
      eq(communicationTemplates.isActive, true),
    ),
  });

  if (smsTemplate && params.customerPhone) {
    await queueCommunicationJob({
      organizationId: params.organizationId,
      templateId: smsTemplate.id,
      triggerType: "appointment_scheduled",
      channel: "sms",
      recipientPhone: params.customerPhone,
      templateVariables: {
        customerName: params.customerName,
        technicianName: params.technicianName,
        appointmentDate: params.appointmentDate,
        appointmentTime: params.appointmentTime,
        appointmentAddress: params.appointmentAddress,
        serviceType: params.serviceType,
        companyName: params.companyName,
        phoneNumber: params.phoneNumber,
      },
      scheduledFor: new Date(), // Send immediately
      priority: 50,
      customerId: params.customerId,
      serviceRequestId: params.serviceRequestId,
    });
  }

  // Queue email if customer has email and email template exists
  if (params.customerEmail) {
    const emailTemplate = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.organizationId, params.organizationId),
        eq(communicationTemplates.triggerType, "appointment_scheduled"),
        eq(communicationTemplates.templateType, "email_html"),
        eq(communicationTemplates.isActive, true),
      ),
    });

    if (emailTemplate) {
      await queueCommunicationJob({
        organizationId: params.organizationId,
        templateId: emailTemplate.id,
        triggerType: "appointment_scheduled",
        channel: "email",
        recipientEmail: params.customerEmail,
        templateVariables: {
          customerName: params.customerName,
          technicianName: params.technicianName,
          appointmentDate: params.appointmentDate,
          appointmentTime: params.appointmentTime,
          appointmentAddress: params.appointmentAddress,
          serviceType: params.serviceType,
          companyName: params.companyName,
          phoneNumber: params.phoneNumber,
        },
        scheduledFor: new Date(),
        priority: 50,
        customerId: params.customerId,
        serviceRequestId: params.serviceRequestId,
      });
    }
  }
}

/**
 * Schedule appointment reminders
 *
 * Called when an appointment is scheduled to queue up reminder messages.
 * Creates jobs for 24-hour and 2-hour reminders.
 *
 * @param params - Appointment details
 */
export async function scheduleAppointmentReminders(params: {
  organizationId: string;
  serviceRequestId: string;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  technicianName: string;
  appointmentDate: Date;
  appointmentTime: string;
  appointmentAddress: string;
  companyName: string;
  phoneNumber: string;
}): Promise<void> {
  const now = new Date();
  const appointmentTime = new Date(params.appointmentDate);
  const [hours, minutes] = params.appointmentTime.split(":").map(Number);
  appointmentTime.setHours(hours, minutes, 0, 0);

  // Calculate reminder times
  const reminder24h = new Date(appointmentTime);
  reminder24h.setHours(reminder24h.getHours() - 24);

  const reminder2h = new Date(appointmentTime);
  reminder2h.setHours(reminder2h.getHours() - 2);

  // Queue 24-hour reminder (if in the future)
  if (reminder24h > now) {
    const smsTemplate = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.organizationId, params.organizationId),
        eq(communicationTemplates.triggerType, "appointment_reminder_24h"),
        eq(communicationTemplates.templateType, "sms"),
        eq(communicationTemplates.isActive, true),
      ),
    });

    if (smsTemplate && params.customerPhone) {
      await queueCommunicationJob({
        organizationId: params.organizationId,
        templateId: smsTemplate.id,
        triggerType: "appointment_reminder_24h",
        channel: "sms",
        recipientPhone: params.customerPhone,
        templateVariables: {
          customerName: params.customerName,
          appointmentDate: params.appointmentDate,
          appointmentTime: params.appointmentTime,
          appointmentAddress: params.appointmentAddress,
          technicianName: params.technicianName,
          companyName: params.companyName,
          phoneNumber: params.phoneNumber,
        },
        scheduledFor: reminder24h,
        priority: 40,
        customerId: params.customerId,
        serviceRequestId: params.serviceRequestId,
      });
    }
  }

  // Queue 2-hour reminder (if in the future)
  if (reminder2h > now) {
    const smsTemplate = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.organizationId, params.organizationId),
        eq(communicationTemplates.triggerType, "appointment_reminder_2h"),
        eq(communicationTemplates.templateType, "sms"),
        eq(communicationTemplates.isActive, true),
      ),
    });

    if (smsTemplate && params.customerPhone) {
      await queueCommunicationJob({
        organizationId: params.organizationId,
        templateId: smsTemplate.id,
        triggerType: "appointment_reminder_2h",
        channel: "sms",
        recipientPhone: params.customerPhone,
        templateVariables: {
          customerName: params.customerName,
          appointmentTime: params.appointmentTime,
          appointmentAddress: params.appointmentAddress,
          technicianName: params.technicianName,
          companyName: params.companyName,
          phoneNumber: params.phoneNumber,
        },
        scheduledFor: reminder2h,
        priority: 60, // Higher priority for time-sensitive reminder
        customerId: params.customerId,
        serviceRequestId: params.serviceRequestId,
      });
    }
  }
}

/**
 * Trigger appointment rescheduled notification
 *
 * Called when an appointment is rescheduled.
 * Cancels pending reminders and creates new ones.
 *
 * @param params - Reschedule details
 */
export async function triggerAppointmentRescheduled(params: {
  organizationId: string;
  serviceRequestId: string;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  newDate: Date;
  newTime: string;
  oldDate: Date;
  oldTime: string;
  appointmentAddress: string;
  companyName: string;
  phoneNumber: string;
}): Promise<void> {
  // Cancel pending reminder jobs for this service request
  await cancelPendingJobsForServiceRequest(params.serviceRequestId);

  // Send rescheduled notification
  const smsTemplate = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, params.organizationId),
      eq(communicationTemplates.triggerType, "appointment_rescheduled"),
      eq(communicationTemplates.templateType, "sms"),
      eq(communicationTemplates.isActive, true),
    ),
  });

  if (smsTemplate && params.customerPhone) {
    await queueCommunicationJob({
      organizationId: params.organizationId,
      templateId: smsTemplate.id,
      triggerType: "appointment_rescheduled",
      channel: "sms",
      recipientPhone: params.customerPhone,
      templateVariables: {
        customerName: params.customerName,
        newDate: params.newDate,
        newTime: params.newTime,
        oldDate: params.oldDate,
        oldTime: params.oldTime,
        appointmentAddress: params.appointmentAddress,
        companyName: params.companyName,
        phoneNumber: params.phoneNumber,
      },
      scheduledFor: new Date(),
      priority: 50,
      customerId: params.customerId,
      serviceRequestId: params.serviceRequestId,
    });
  }

  // Schedule new reminders
  await scheduleAppointmentReminders({
    organizationId: params.organizationId,
    serviceRequestId: params.serviceRequestId,
    customerId: params.customerId,
    customerName: params.customerName,
    customerPhone: params.customerPhone,
    customerEmail: params.customerEmail,
    technicianName: "", // Not needed for reminders
    appointmentDate: params.newDate,
    appointmentTime: params.newTime,
    appointmentAddress: params.appointmentAddress,
    companyName: params.companyName,
    phoneNumber: params.phoneNumber,
  });
}

/**
 * Trigger appointment cancelled notification
 *
 * Called when an appointment is cancelled.
 * Cancels all pending communication jobs for the service request.
 *
 * @param params - Cancellation details
 */
export async function triggerAppointmentCancelled(params: {
  organizationId: string;
  serviceRequestId: string;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  appointmentDate: Date;
  cancellationReason?: string;
  rescheduleLink?: string;
  companyName: string;
  phoneNumber: string;
}): Promise<void> {
  // Cancel all pending jobs for this service request
  await cancelPendingJobsForServiceRequest(params.serviceRequestId);

  // Send cancellation notification
  const smsTemplate = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, params.organizationId),
      eq(communicationTemplates.triggerType, "appointment_cancelled"),
      eq(communicationTemplates.templateType, "sms"),
      eq(communicationTemplates.isActive, true),
    ),
  });

  if (smsTemplate && params.customerPhone) {
    await queueCommunicationJob({
      organizationId: params.organizationId,
      templateId: smsTemplate.id,
      triggerType: "appointment_cancelled",
      channel: "sms",
      recipientPhone: params.customerPhone,
      templateVariables: {
        customerName: params.customerName,
        appointmentDate: params.appointmentDate,
        cancellationReason: params.cancellationReason,
        rescheduleLink: params.rescheduleLink,
        companyName: params.companyName,
        phoneNumber: params.phoneNumber,
      },
      scheduledFor: new Date(),
      priority: 50,
      customerId: params.customerId,
      serviceRequestId: params.serviceRequestId,
    });
  }
}

/**
 * Trigger technician enroute notification
 *
 * Called when a technician marks themselves as en route to an appointment.
 *
 * @param params - Technician enroute details
 */
export async function triggerTechnicianEnroute(params: {
  organizationId: string;
  serviceRequestId: string;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  technicianName: string;
  estimatedArrival: string;
  appointmentAddress: string;
  companyName: string;
  phoneNumber: string;
}): Promise<void> {
  const smsTemplate = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, params.organizationId),
      eq(communicationTemplates.triggerType, "technician_enroute"),
      eq(communicationTemplates.templateType, "sms"),
      eq(communicationTemplates.isActive, true),
    ),
  });

  if (smsTemplate && params.customerPhone) {
    await queueCommunicationJob({
      organizationId: params.organizationId,
      templateId: smsTemplate.id,
      triggerType: "technician_enroute",
      channel: "sms",
      recipientPhone: params.customerPhone,
      templateVariables: {
        customerName: params.customerName,
        technicianName: params.technicianName,
        estimatedArrival: params.estimatedArrival,
        appointmentAddress: params.appointmentAddress,
        companyName: params.companyName,
        phoneNumber: params.phoneNumber,
      },
      scheduledFor: new Date(),
      priority: 70, // High priority - time-sensitive
      customerId: params.customerId,
      serviceRequestId: params.serviceRequestId,
    });
  }
}

/**
 * Trigger job completed notification
 *
 * Called when a service request is marked as completed.
 *
 * @param params - Job completion details
 */
export async function triggerJobCompleted(params: {
  organizationId: string;
  serviceRequestId: string;
  customerId: string;
  customerName: string;
  customerPhone?: string;
  customerEmail?: string;
  technicianName: string;
  servicePerformed: string;
  totalAmount?: string;
  paymentLink?: string;
  reviewLink: string;
  companyName: string;
  phoneNumber: string;
}): Promise<void> {
  // Send SMS notification
  const smsTemplate = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, params.organizationId),
      eq(communicationTemplates.triggerType, "job_completed"),
      eq(communicationTemplates.templateType, "sms"),
      eq(communicationTemplates.isActive, true),
    ),
  });

  if (smsTemplate && params.customerPhone) {
    await queueCommunicationJob({
      organizationId: params.organizationId,
      templateId: smsTemplate.id,
      triggerType: "job_completed",
      channel: "sms",
      recipientPhone: params.customerPhone,
      templateVariables: {
        customerName: params.customerName,
        technicianName: params.technicianName,
        servicePerformed: params.servicePerformed,
        totalAmount: params.totalAmount,
        paymentLink: params.paymentLink,
        reviewLink: params.reviewLink,
        companyName: params.companyName,
        phoneNumber: params.phoneNumber,
      },
      scheduledFor: new Date(),
      priority: 50,
      customerId: params.customerId,
      serviceRequestId: params.serviceRequestId,
    });
  }

  // Send email with review request
  const emailTemplate = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, params.organizationId),
      eq(communicationTemplates.triggerType, "job_completed"),
      eq(communicationTemplates.templateType, "email_html"),
      eq(communicationTemplates.isActive, true),
    ),
  });

  if (emailTemplate && params.customerEmail) {
    await queueCommunicationJob({
      organizationId: params.organizationId,
      templateId: emailTemplate.id,
      triggerType: "job_completed",
      channel: "email",
      recipientEmail: params.customerEmail,
      templateVariables: {
        customerName: params.customerName,
        technicianName: params.technicianName,
        servicePerformed: params.servicePerformed,
        totalAmount: params.totalAmount,
        paymentLink: params.paymentLink,
        reviewLink: params.reviewLink,
        companyName: params.companyName,
        phoneNumber: params.phoneNumber,
      },
      scheduledFor: new Date(),
      priority: 50,
      customerId: params.customerId,
      serviceRequestId: params.serviceRequestId,
    });
  }

  // Schedule follow-up in 3 days
  const followUpDate = new Date();
  followUpDate.setDate(followUpDate.getDate() + 3);

  const followUpTemplate = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, params.organizationId),
      eq(communicationTemplates.triggerType, "follow_up"),
      eq(communicationTemplates.templateType, "sms"),
      eq(communicationTemplates.isActive, true),
    ),
  });

  if (followUpTemplate && params.customerPhone) {
    await queueCommunicationJob({
      organizationId: params.organizationId,
      templateId: followUpTemplate.id,
      triggerType: "follow_up",
      channel: "sms",
      recipientPhone: params.customerPhone,
      templateVariables: {
        customerName: params.customerName,
        serviceDate: params.servicePerformed, // Using servicePerformed as date proxy
        companyName: params.companyName,
        phoneNumber: params.phoneNumber,
      },
      scheduledFor: followUpDate,
      priority: 30,
      customerId: params.customerId,
      serviceRequestId: params.serviceRequestId,
    });
  }
}

/**
 * Cancel all pending communication jobs for a service request
 *
 * @param serviceRequestId - Service request ID
 */
async function cancelPendingJobsForServiceRequest(
  serviceRequestId: string,
): Promise<void> {
  const { communicationJobs } = await import("@/lib/db/schema");
  const { eq, and } = await import("drizzle-orm");

  await db
    .update(communicationJobs)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(communicationJobs.serviceRequestId, serviceRequestId),
        eq(communicationJobs.status, "pending"),
      ),
    );
}
