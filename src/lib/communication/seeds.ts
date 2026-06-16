/**
 * Communication Templates Seed
 *
 * Creates default communication templates for each organization.
 * Run this when a new organization is created or to reset templates.
 */

import { db } from "@/lib/db";
import { communicationTemplates, organizations } from "@/lib/db/schema";
import { and, eq } from "drizzle-orm";

/**
 * Default templates for each trigger type
 */
const defaultTemplates = [
  {
    key: "appointment_scheduled_sms",
    name: "Appointment Scheduled (SMS)",
    description: "Sent when a new appointment is scheduled",
    triggerType: "appointment_scheduled",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `{{companyName}}: Your {{serviceType}} is scheduled for {{date appointmentDate "short"}} at {{appointmentTime}}. Technician: {{technicianName}}. Address: {{appointmentAddress}}. Reply or call {{phoneNumber}} to change.`,
    variables: {
      customerName: "Customer name",
      technicianName: "Technician name",
      appointmentDate: "Appointment date",
      appointmentTime: "Appointment time",
      appointmentAddress: "Service address",
      serviceType: "Type of service",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 50,
  },
  {
    key: "appointment_reminder_24h_sms",
    name: "24-Hour Reminder (SMS)",
    description: "Sent 24 hours before the appointment",
    triggerType: "appointment_reminder_24h",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `Reminder: {{companyName}} technician {{technicianName}} will arrive tomorrow {{date appointmentDate "short"}} at {{appointmentTime}} at {{appointmentAddress}}. Questions? Call {{phoneNumber}}.`,
    variables: {
      customerName: "Customer name",
      appointmentDate: "Appointment date",
      appointmentTime: "Appointment time",
      appointmentAddress: "Service address",
      technicianName: "Technician name",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 40,
  },
  {
    key: "appointment_reminder_2h_sms",
    name: "2-Hour Reminder (SMS)",
    description: "Sent 2 hours before the appointment",
    triggerType: "appointment_reminder_2h",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `{{companyName}}: {{technicianName}} is on the way! Arriving around {{appointmentTime}} at {{appointmentAddress}}. Please ensure access.`,
    variables: {
      customerName: "Customer name",
      appointmentTime: "Appointment time",
      appointmentAddress: "Service address",
      technicianName: "Technician name",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 60,
  },
  {
    key: "appointment_rescheduled_sms",
    name: "Appointment Rescheduled (SMS)",
    description: "Sent when an appointment is rescheduled",
    triggerType: "appointment_rescheduled",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `{{companyName}}: Appointment rescheduled from {{date oldDate "short"}} {{oldTime}} to {{date newDate "short"}} {{newTime}} at {{appointmentAddress}}. Call {{phoneNumber}} to confirm.`,
    variables: {
      customerName: "Customer name",
      newDate: "New appointment date",
      newTime: "New appointment time",
      oldDate: "Original appointment date",
      oldTime: "Original appointment time",
      appointmentAddress: "Service address",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 50,
  },
  {
    key: "appointment_cancelled_sms",
    name: "Appointment Cancelled (SMS)",
    description: "Sent when an appointment is cancelled",
    triggerType: "appointment_cancelled",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `{{companyName}}: Your appointment for {{date appointmentDate "short"}} has been cancelled. {{#if cancellationReason}}Reason: {{cancellationReason}}. {{/if}}{{#if rescheduleLink}}Book a new time: {{rescheduleLink}}{{/if}}`,
    variables: {
      customerName: "Customer name",
      appointmentDate: "Appointment date",
      cancellationReason: "Reason for cancellation",
      rescheduleLink: "Link to reschedule",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 50,
  },
  {
    key: "technician_enroute_sms",
    name: "Technician En Route (SMS)",
    description: "Sent when technician is on the way",
    triggerType: "technician_enroute",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `{{companyName}}: {{technicianName}} is on the way! ETA: {{estimatedArrival}} at {{appointmentAddress}}.`,
    variables: {
      customerName: "Customer name",
      technicianName: "Technician name",
      estimatedArrival: "Estimated arrival time",
      appointmentAddress: "Service address",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 70,
  },
  {
    key: "job_completed_sms",
    name: "Job Completed (SMS)",
    description: "Sent when service is completed",
    triggerType: "job_completed",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `{{companyName}}: Service complete. {{#if totalAmount}}Total: {{totalAmount}}. {{/if}}{{#if paymentLink}}Pay here: {{paymentLink}} {{/if}}Rate your experience: {{reviewLink}}`,
    variables: {
      customerName: "Customer name",
      technicianName: "Technician name",
      servicePerformed: "Service performed",
      totalAmount: "Total amount",
      paymentLink: "Payment link",
      reviewLink: "Review link",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 50,
  },
  {
    key: "job_completed_email",
    name: "Job Completed (Email)",
    description: "Email sent when service is completed",
    triggerType: "job_completed",
    templateType: "email_html" as const,
    subjectTemplate: `Service Complete - {{companyName}}`,
    bodyTemplate: `{{companyName}}: {{technicianName}} has completed the {{servicePerformed}}. {{#if totalAmount}}Total: {{totalAmount}}.{{/if}}`,
    variables: {
      customerName: "Customer name",
      technicianName: "Technician name",
      servicePerformed: "Service performed",
      totalAmount: "Total amount",
      paymentLink: "Payment link",
      reviewLink: "Review link",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 50,
  },
  {
    key: "review_request_sms",
    name: "Review Request (SMS)",
    description: "Request for customer review",
    triggerType: "review_request",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `How was your {{serviceName}} with {{companyName}}? Share feedback: {{reviewLink}}`,
    variables: {
      customerName: "Customer name",
      serviceName: "Service name",
      reviewLink: "Review link",
      companyName: "Company name",
    },
    priority: 40,
  },
  {
    key: "follow_up_sms",
    name: "Follow Up (SMS)",
    description: "Follow-up after service completion",
    triggerType: "follow_up",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `{{companyName}}: How is everything since your {{date serviceDate "short"}} service? {{#if feedbackLink}}Quick feedback: {{feedbackLink}} {{/if}}Questions? Call {{phoneNumber}}.`,
    variables: {
      customerName: "Customer name",
      serviceDate: "Service date",
      feedbackLink: "Feedback link",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 30,
  },
  {
    key: "estimate_sent_sms",
    name: "Estimate Sent (SMS)",
    description: "Sends the customer the tokenized estimate approval link",
    triggerType: "estimate_sent",
    templateType: "sms" as const,
    subjectTemplate: null,
    // LINK ONLY — the binding price lives behind the tokenized page.
    bodyTemplate: `{{companyName}}: Your estimate is ready: {{approvalUrl}}`,
    variables: {
      customerName: "Customer name",
      approvalUrl: "Tokenized approval link",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 50,
  },
  {
    key: "payment_receipt_sms",
    name: "Payment Receipt (SMS)",
    description: "Confirms a successful payment on an invoice",
    triggerType: "payment_receipt",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `Thanks{{#if customerName}}, {{customerName}}{{/if}}! {{companyName}} received your payment of {{amount}} for invoice {{invoiceNumber}}.`,
    variables: {
      customerName: "Customer name",
      amount: "Amount paid (formatted dollars)",
      invoiceNumber: "Invoice reference",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 60,
  },
  {
    key: "invoice_overdue_sms",
    name: "Invoice Overdue Reminder (SMS)",
    description: "Polite reminder that an invoice is still open (dunning)",
    triggerType: "invoice_overdue",
    templateType: "sms" as const,
    subjectTemplate: null,
    bodyTemplate: `{{companyName}}: A friendly reminder that invoice {{invoiceNumber}} ({{amount}}) is still open. {{#if payLink}}Pay here: {{payLink}} {{/if}}Questions? Call {{phoneNumber}}.`,
    variables: {
      customerName: "Customer name",
      amount: "Outstanding balance (formatted dollars)",
      invoiceNumber: "Invoice reference",
      payLink: "Optional payment link",
      companyName: "Company name",
      phoneNumber: "Company phone",
    },
    priority: 30,
  },
];

/**
 * Create default templates for an organization
 *
 * @param organizationId - Organization ID
 */
export async function seedCommunicationTemplates(
  organizationId: string,
): Promise<void> {
  for (const template of defaultTemplates) {
    // Check if template already exists FOR THIS ORG (templates are per-org;
    // a global key check skipped every org after the first).
    const existing = await db.query.communicationTemplates.findFirst({
      where: and(
        eq(communicationTemplates.organizationId, organizationId),
        eq(communicationTemplates.key, template.key),
      ),
    });

    if (existing) {
      continue; // Skip if already exists
    }

    await db.insert(communicationTemplates).values({
      organizationId,
      key: template.key,
      name: template.name,
      description: template.description,
      triggerType: template.triggerType as any,
      templateType: template.templateType as any,
      subjectTemplate: template.subjectTemplate ?? undefined,
      bodyTemplate: template.bodyTemplate,
      variables: template.variables as any,
      isActive: true,
      priority: template.priority,
    });
  }
}

/**
 * Seed templates for all organizations that don't have them yet
 */
export async function seedAllOrganizationTemplates(): Promise<{
  seeded: number;
  skipped: number;
}> {
  const orgs = await db.select().from(organizations);

  let seeded = 0;
  let skipped = 0;

  for (const org of orgs) {
    // Check if org already has templates
    const existingCount = await db.query.communicationTemplates.findMany({
      where: eq(communicationTemplates.organizationId, org.id),
    });

    if (existingCount.length > 0) {
      skipped++;
      continue;
    }

    await seedCommunicationTemplates(org.id);
    seeded++;
  }

  return { seeded, skipped };
}
