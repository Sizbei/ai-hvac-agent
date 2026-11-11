/**
 * SMS Template Engine
 *
 * Uses Handlebars for template rendering with type-safe variable handling.
 * SMS messages are plain text with a 160-character limit per segment.
 */

import Handlebars from "handlebars";

// Register common Handlebars helpers
Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);
Handlebars.registerHelper("ne", (a: unknown, b: unknown) => a !== b);
Handlebars.registerHelper("gt", (a: number, b: number) => a > b);
Handlebars.registerHelper("lt", (a: number, b: number) => a < b);
Handlebars.registerHelper("gte", (a: number, b: number) => a >= b);
Handlebars.registerHelper("lte", (a: number, b: number) => a <= b);
Handlebars.registerHelper("and", (...args: unknown[]) => {
  // Filter out the Handlebars options object
  const values = args.slice(0, -1);
  return values.every(Boolean);
});
Handlebars.registerHelper("or", (...args: unknown[]) => {
  // Filter out the Handlebars options object
  const values = args.slice(0, -1);
  return values.some(Boolean);
});
Handlebars.registerHelper("not", (value: unknown) => !value);

// Date formatting helper (short format for SMS)
Handlebars.registerHelper("date", (value: string | Date, format: string) => {
  const date = typeof value === "string" ? new Date(value) : value;
  if (isNaN(date.getTime())) return "";

  switch (format) {
    case "short":
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      });
    case "time":
      return date.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      });
    case "datetime":
      return date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    default:
      return date.toLocaleDateString("en-US");
  }
});

// Conditional helper for showing content
Handlebars.registerHelper("if", function (
  this: unknown,
  conditional: unknown,
  options: Handlebars.HelperOptions,
) {
  if (conditional) {
    return options.fn(this);
  }
  return options.inverse(this);
});

/**
 * Available template variables for each trigger type
 * This provides type safety and documentation
 */
export const templateVariableSchemas = {
  appointment_scheduled: {
    customerName: "string",
    technicianName: "string",
    appointmentDate: "Date",
    appointmentTime: "string",
    appointmentAddress: "string",
    serviceType: "string",
    companyName: "string",
    phoneNumber: "string",
  },
  appointment_reminder_24h: {
    customerName: "string",
    appointmentDate: "Date",
    appointmentTime: "string",
    appointmentAddress: "string",
    technicianName: "string",
    companyName: "string",
    phoneNumber: "string",
  },
  appointment_reminder_2h: {
    customerName: "string",
    appointmentTime: "string",
    appointmentAddress: "string",
    technicianName: "string",
    companyName: "string",
    phoneNumber: "string",
  },
  appointment_rescheduled: {
    customerName: "string",
    newDate: "Date",
    newTime: "string",
    oldDate: "Date",
    oldTime: "string",
    appointmentAddress: "string",
    companyName: "string",
    phoneNumber: "string",
  },
  appointment_cancelled: {
    customerName: "string",
    appointmentDate: "Date",
    cancellationReason: "string?",
    rescheduleLink: "string?",
    companyName: "string",
    phoneNumber: "string",
  },
  technician_enroute: {
    customerName: "string",
    technicianName: "string",
    estimatedArrival: "string",
    appointmentAddress: "string",
    companyName: "string",
    phoneNumber: "string",
  },
  technician_arrived: {
    customerName: "string",
    technicianName: "string",
    companyName: "string",
    phoneNumber: "string",
  },
  job_completed: {
    customerName: "string",
    technicianName: "string",
    servicePerformed: "string",
    totalAmount: "string?",
    paymentLink: "string?",
    reviewLink: "string",
    companyName: "string",
    phoneNumber: "string",
  },
  review_request: {
    customerName: "string",
    serviceName: "string",
    reviewLink: "string",
    companyName: "string",
  },
  follow_up: {
    customerName: "string",
    serviceDate: "Date",
    satisfactionScore: "number?",
    feedbackLink: "string?",
    companyName: "string",
    phoneNumber: "string",
  },
  escalation: {
    customerName: "string",
    issueType: "string",
    managerName: "string",
    managerPhone: "string",
    companyName: "string",
  },
  estimate_sent: {
    customerName: "string",
    approvalUrl: "string",
    companyName: "string",
    phoneNumber: "string",
  },
  payment_receipt: {
    customerName: "string",
    amount: "string",
    invoiceNumber: "string",
    companyName: "string",
    phoneNumber: "string",
  },
  invoice_overdue: {
    customerName: "string",
    amount: "string",
    invoiceNumber: "string",
    payLink: "string?",
    companyName: "string",
    phoneNumber: "string",
  },
  // Lead-gen warranty-expiry nudge — NO price ever (a check-up invite, not a quote).
  warranty_expiring: {
    customerName: "string",
    equipment: "string",
    expiryDate: "string",
    companyName: "string",
    phoneNumber: "string",
  },
  // M3b: texted when a field invoice is finalized — link to the portal page.
  invoice_sent: {
    customerName: "string",
    amount: "string",
    invoiceNumber: "string",
    payLink: "string",
    companyName: "string",
    phoneNumber: "string",
  },
} as const;

export type TemplateVariables = typeof templateVariableSchemas;

/**
 * Single source of truth for trigger types, mirroring
 * communicationTriggerTypeEnum (schema.ts). Consumed by the templates CRUD
 * zod schemas (api/admin/communications/templates/route.ts, [id]/route.ts)
 * and the editor dropdown (template-editor-dialog.tsx) so the two can't
 * drift out of sync again. Keep in the same order as the DB enum.
 */
export const COMMUNICATION_TRIGGER_TYPES = [
  { value: "appointment_scheduled", label: "Appointment scheduled" },
  { value: "appointment_reminder_24h", label: "24-hour reminder" },
  { value: "appointment_reminder_2h", label: "2-hour reminder" },
  { value: "appointment_rescheduled", label: "Appointment rescheduled" },
  { value: "appointment_cancelled", label: "Appointment cancelled" },
  { value: "technician_enroute", label: "Technician en route" },
  { value: "technician_arrived", label: "Technician arrived" },
  { value: "job_completed", label: "Visit completed" },
  { value: "review_request", label: "Review text" },
  { value: "follow_up", label: "Follow up" },
  { value: "escalation", label: "Escalation" },
  { value: "estimate_sent", label: "Estimate sent" },
  { value: "payment_receipt", label: "Payment receipt" },
  { value: "invoice_overdue", label: "Invoice overdue" },
  { value: "warranty_expiring", label: "Warranty expiring" },
  { value: "invoice_sent", label: "Invoice ready" },
] as const;

export type CommunicationTriggerType =
  (typeof COMMUNICATION_TRIGGER_TYPES)[number]["value"];

/** Values-only tuple, shaped for `z.enum()`. */
export const COMMUNICATION_TRIGGER_TYPE_VALUES =
  COMMUNICATION_TRIGGER_TYPES.map((t) => t.value) as [
    CommunicationTriggerType,
    ...CommunicationTriggerType[],
  ];

/**
 * Compiled template cache
 */
const templateCache = new Map<string, HandlebarsTemplateDelegate>();

/**
 * Render an SMS template with the given variables
 *
 * @param template - Handlebars template string
 * @param variables - Variables to inject into the template
 * @returns Rendered SMS message
 */
export function renderSmsTemplate(
  template: string,
  variables: Record<string, unknown>,
): string {
  // Check cache first
  let compiled = templateCache.get(template);
  if (!compiled) {
    // A text message is plain text: HTML-escaping turns O'Neil & Sons into
    // O&#x27;Neil &amp; Sons on the customer's phone and breaks link queries.
    compiled = Handlebars.compile(template, { strict: true, noEscape: true });
    templateCache.set(template, compiled);
  }

  try {
    const rendered = compiled(variables);
    return rendered.trim();
  } catch (error) {
    console.error("SMS template rendering error:", error);
    throw new Error(`Failed to render SMS template: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Validate template syntax without rendering
 *
 * @param template - Handlebars template string
 * @returns true if valid, throws if invalid
 */
export function validateSmsTemplate(template: string): true {
  try {
    Handlebars.compile(template, { strict: true });
    return true;
  } catch (error) {
    throw new Error(`Invalid template syntax: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}

/**
 * Check if rendered message exceeds SMS segment limits
 *
 * A single SMS segment is 160 characters. GSM-7 encoding is assumed.
 * Multi-part messages concatenate at 153 characters per segment.
 *
 * @param message - Rendered message text
 * @returns Object with segment count and character count
 */
export function getSmsSegmentInfo(message: string): {
  segments: number;
  characters: number;
  withinSingleSegment: boolean;
} {
  const characters = message.length;
  // GSM-7: 160 chars for single, 153 for concatenated segments
  const segments = characters <= 160 ? 1 : Math.ceil(characters / 153);

  return {
    segments,
    characters,
    withinSingleSegment: segments === 1,
  };
}

/**
 * Default SMS templates for each trigger type
 * These can be overridden by organization-specific templates
 */
export const defaultSmsTemplates: Record<
  keyof typeof templateVariableSchemas,
  { subject?: never; body: string }
> = {
  appointment_scheduled: {
    body: `{{companyName}}: Your {{serviceType}} is scheduled for {{date appointmentDate "short"}} at {{appointmentTime}}. Technician: {{technicianName}}. Address: {{appointmentAddress}}. Reply or call {{phoneNumber}} to change.`,
  },
  appointment_reminder_24h: {
    body: `Reminder: {{companyName}} technician {{technicianName}} will arrive tomorrow {{date appointmentDate "short"}} at {{appointmentTime}} at {{appointmentAddress}}. Questions? Call {{phoneNumber}}.`,
  },
  appointment_reminder_2h: {
    body: `{{companyName}}: {{technicianName}} is on the way! Arriving around {{appointmentTime}} at {{appointmentAddress}}. Please ensure access.`,
  },
  appointment_rescheduled: {
    body: `{{companyName}}: Appointment rescheduled from {{date oldDate "short"}} {{oldTime}} to {{date newDate "short"}} {{newTime}} at {{appointmentAddress}}. Call {{phoneNumber}} to confirm.`,
  },
  appointment_cancelled: {
    body: `{{companyName}}: Your appointment for {{date appointmentDate "short"}} has been cancelled. {{#if cancellationReason}}Reason: {{cancellationReason}}. {{/if}}{{#if rescheduleLink}}Book a new time: {{rescheduleLink}}{{/if}}`,
  },
  technician_enroute: {
    body: `{{companyName}}: {{technicianName}} is on the way! ETA: {{estimatedArrival}} at {{appointmentAddress}}.`,
  },
  technician_arrived: {
    body: `{{companyName}}: {{technicianName}} has arrived at your location.`,
  },
  job_completed: {
    body: `{{companyName}}: Service complete. {{#if totalAmount}}Total: {{totalAmount}}. {{/if}}{{#if paymentLink}}Pay here: {{paymentLink}} {{/if}}Rate your experience: {{reviewLink}}`,
  },
  review_request: {
    body: `How was your {{serviceName}} with {{companyName}}? Share feedback: {{reviewLink}}`,
  },
  follow_up: {
    body: `{{companyName}}: How is everything since your {{date serviceDate "short"}} service? {{#if feedbackLink}}Quick feedback: {{feedbackLink}} {{/if}}Questions? Call {{phoneNumber}}.`,
  },
  escalation: {
    body: `{{companyName}}: Your {{issueType}} concern has been escalated to manager {{managerName}}. They will contact you shortly at {{managerPhone}}.`,
  },
  // Money-loop. estimate_sent sends the LINK ONLY — the binding price lives behind
  // the tokenized approval page (never promise pricing in an SMS body).
  estimate_sent: {
    body: `{{companyName}}: Your estimate is ready: {{approvalUrl}}`,
  },
  payment_receipt: {
    body: `Thanks{{#if customerName}}, {{customerName}}{{/if}}! {{companyName}} received your payment of {{amount}} for invoice {{invoiceNumber}}.`,
  },
  invoice_overdue: {
    body: `{{companyName}}: A friendly reminder that invoice {{invoiceNumber}} ({{amount}}) is still open. {{#if payLink}}Pay here: {{payLink}} {{/if}}Questions? Call {{phoneNumber}}.`,
  },
  // Lead-gen warranty-expiry nudge — invites a check-up, NEVER quotes a price.
  warranty_expiring: {
    body: `{{companyName}}: Your {{equipment}} warranty expires {{expiryDate}} — reply to schedule a check-up. Questions? Call {{phoneNumber}}.`,
  },
  invoice_sent: {
    body: `{{companyName}}: your invoice {{invoiceNumber}} ({{amount}}) is ready to view: {{payLink}}`,
  },
} as const;
