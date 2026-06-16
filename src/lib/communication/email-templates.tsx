/**
 * Email Template Engine
 *
 * Uses React Email for rendering beautiful, responsive HTML emails.
 * Each template is a React component that receives typed variables.
 */

import { Html } from "@react-email/html";
import { Text } from "@react-email/text";
import { Button } from "@react-email/button";
import { render } from "@react-email/render";

// Email styling constants
const BRAND_COLOR = "#2563eb";
const TEXT_COLOR = "#374151";
const BACKGROUND_COLOR = "#f9fafb";
const CONTAINER_STYLE = {
  backgroundColor: BACKGROUND_COLOR,
  padding: "40px 20px",
  fontFamily: "system-ui, -apple-system, sans-serif",
};
const CARD_STYLE = {
  backgroundColor: "#ffffff",
  borderRadius: "8px",
  padding: "32px",
  maxWidth: "600px",
  margin: "0 auto",
  boxShadow: "0 1px 3px rgba(0, 0, 0, 0.1)",
};
const HEADING_STYLE = {
  color: TEXT_COLOR,
  fontSize: "24px",
  fontWeight: "600",
  margin: "0 0 16px 0",
};
const PARAGRAPH_STYLE = {
  color: TEXT_COLOR,
  fontSize: "16px",
  lineHeight: "1.6",
  margin: "0 0 16px 0",
};
const BUTTON_STYLE = {
  backgroundColor: BRAND_COLOR,
  color: "#ffffff",
  padding: "12px 24px",
  borderRadius: "6px",
  textDecoration: "none",
  display: "inline-block",
  fontWeight: "500",
};
const FOOTER_STYLE = {
  color: "#6b7280",
  fontSize: "14px",
  marginTop: "24px",
  textAlign: "center" as const,
};

/**
 * Template variable types (same as SMS templates)
 */
export interface AppointmentScheduledVars {
  customerName: string;
  technicianName: string;
  appointmentDate: Date | string;
  appointmentTime: string;
  appointmentAddress: string;
  serviceType: string;
  companyName: string;
  phoneNumber: string;
}

export interface AppointmentReminderVars {
  customerName: string;
  appointmentDate: Date | string;
  appointmentTime: string;
  appointmentAddress: string;
  technicianName: string;
  companyName: string;
  phoneNumber: string;
}

export interface AppointmentRescheduledVars {
  customerName: string;
  newDate: Date | string;
  newTime: string;
  oldDate: Date | string;
  oldTime: string;
  appointmentAddress: string;
  companyName: string;
  phoneNumber: string;
}

export interface AppointmentCancelledVars {
  customerName: string;
  appointmentDate: Date | string;
  cancellationReason?: string;
  rescheduleLink?: string;
  companyName: string;
  phoneNumber: string;
}

export interface JobCompletedVars {
  customerName: string;
  technicianName: string;
  servicePerformed: string;
  totalAmount?: string;
  paymentLink?: string;
  reviewLink: string;
  companyName: string;
  phoneNumber: string;
}

export interface ReviewRequestVars {
  customerName: string;
  serviceName: string;
  reviewLink: string;
  companyName: string;
}

/**
 * Email template components
 */

export function AppointmentScheduledEmail({
  customerName,
  technicianName,
  appointmentDate,
  appointmentTime,
  appointmentAddress,
  serviceType,
  companyName,
  phoneNumber,
}: AppointmentScheduledVars) {
  const formattedDate =
    typeof appointmentDate === "string"
      ? new Date(appointmentDate).toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        })
      : appointmentDate.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        });

  return (
    <Html lang="en">
      <div style={CONTAINER_STYLE}>
        <div style={CARD_STYLE}>
          <h1 style={HEADING_STYLE}>Appointment Confirmed</h1>
          <Text style={PARAGRAPH_STYLE}>
            Hi {customerName},
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            Your {serviceType} appointment has been scheduled for:
          </Text>
          <Text
            style={{
              ...PARAGRAPH_STYLE,
              fontWeight: "600",
              backgroundColor: "#f3f4f6",
              padding: "16px",
              borderRadius: "6px",
              margin: "16px 0",
            }}
          >
            {formattedDate} at {appointmentTime}
            <br />
            <span style={{ fontWeight: "400", fontSize: "14px" }}>
              with {technicianName}
            </span>
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            <strong>Location:</strong> {appointmentAddress}
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            Need to reschedule? Reply to this email or call us at {phoneNumber}.
          </Text>
          <Text style={FOOTER_STYLE}>
            {companyName}
          </Text>
        </div>
      </div>
    </Html>
  );
}

export function AppointmentReminderEmail({
  customerName,
  appointmentDate,
  appointmentTime,
  appointmentAddress,
  technicianName,
  companyName,
  phoneNumber,
}: AppointmentReminderVars) {
  const formattedDate =
    typeof appointmentDate === "string"
      ? new Date(appointmentDate).toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        })
      : appointmentDate.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        });

  return (
    <Html lang="en">
      <div style={CONTAINER_STYLE}>
        <div style={CARD_STYLE}>
          <h1 style={HEADING_STYLE}>Appointment Reminder</h1>
          <Text style={PARAGRAPH_STYLE}>
            Hi {customerName},
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            This is a reminder that you have an appointment tomorrow:
          </Text>
          <Text
            style={{
              ...PARAGRAPH_STYLE,
              fontWeight: "600",
              backgroundColor: "#f3f4f6",
              padding: "16px",
              borderRadius: "6px",
              margin: "16px 0",
            }}
          >
            {formattedDate} at {appointmentTime}
            <br />
            <span style={{ fontWeight: "400", fontSize: "14px" }}>
              Technician: {technicianName}
            </span>
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            <strong>Location:</strong> {appointmentAddress}
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            Questions? Call us at {phoneNumber}.
          </Text>
          <Text style={FOOTER_STYLE}>
            {companyName}
          </Text>
        </div>
      </div>
    </Html>
  );
}

export function AppointmentRescheduledEmail({
  customerName,
  newDate,
  newTime,
  oldDate,
  oldTime,
  appointmentAddress,
  companyName,
  phoneNumber,
}: AppointmentRescheduledVars) {
  const formattedNewDate =
    typeof newDate === "string"
      ? new Date(newDate).toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        })
      : newDate.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        });

  const formattedOldDate =
    typeof oldDate === "string"
      ? new Date(oldDate).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })
      : oldDate.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        });

  return (
    <Html lang="en">
      <div style={CONTAINER_STYLE}>
        <div style={CARD_STYLE}>
          <h1 style={HEADING_STYLE}>Appointment Rescheduled</h1>
          <Text style={PARAGRAPH_STYLE}>
            Hi {customerName},
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            Your appointment has been rescheduled:
          </Text>
          <Text style={{ ...PARAGRAPH_STYLE, color: "#dc2626" }}>
            <del>
              {formattedOldDate} at {oldTime}
            </del>
          </Text>
          <Text
            style={{
              ...PARAGRAPH_STYLE,
              fontWeight: "600",
              backgroundColor: "#ecfdf5",
              color: "#059669",
              padding: "16px",
              borderRadius: "6px",
              margin: "16px 0",
            }}
          >
            New: {formattedNewDate} at {newTime}
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            <strong>Location:</strong> {appointmentAddress}
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            Please confirm by calling {phoneNumber}.
          </Text>
          <Text style={FOOTER_STYLE}>
            {companyName}
          </Text>
        </div>
      </div>
    </Html>
  );
}

export function AppointmentCancelledEmail({
  customerName,
  appointmentDate,
  cancellationReason,
  rescheduleLink,
  companyName,
  phoneNumber,
}: AppointmentCancelledVars) {
  const formattedDate =
    typeof appointmentDate === "string"
      ? new Date(appointmentDate).toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        })
      : appointmentDate.toLocaleDateString("en-US", {
          weekday: "long",
          month: "long",
          day: "numeric",
        });

  return (
    <Html lang="en">
      <div style={CONTAINER_STYLE}>
        <div style={CARD_STYLE}>
          <h1 style={{ ...HEADING_STYLE, color: "#dc2626" }}>
            Appointment Cancelled
          </h1>
          <Text style={PARAGRAPH_STYLE}>
            Hi {customerName},
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            Your appointment for {formattedDate} has been cancelled.
          </Text>
          {cancellationReason && (
            <Text style={PARAGRAPH_STYLE}>
              <strong>Reason:</strong> {cancellationReason}
            </Text>
          )}
          {rescheduleLink && (
            <>
              <Text style={PARAGRAPH_STYLE}>
                Would you like to reschedule?
              </Text>
              <Button href={rescheduleLink} style={BUTTON_STYLE}>
                Book a New Appointment
              </Button>
            </>
          )}
          <Text style={PARAGRAPH_STYLE}>
            Questions? Call us at {phoneNumber}.
          </Text>
          <Text style={FOOTER_STYLE}>
            {companyName}
          </Text>
        </div>
      </div>
    </Html>
  );
}

export function JobCompletedEmail({
  customerName,
  technicianName,
  servicePerformed,
  totalAmount,
  paymentLink,
  reviewLink,
  companyName,
  phoneNumber,
}: JobCompletedVars) {
  return (
    <Html lang="en">
      <div style={CONTAINER_STYLE}>
        <div style={CARD_STYLE}>
          <h1 style={{ ...HEADING_STYLE, color: "#059669" }}>
            Service Complete
          </h1>
          <Text style={PARAGRAPH_STYLE}>
            Hi {customerName},
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            {technicianName} has completed the {servicePerformed}. We hope
            everything is working perfectly!
          </Text>
          {totalAmount && (
            <Text style={PARAGRAPH_STYLE}>
              <strong>Total:</strong> {totalAmount}
            </Text>
          )}
          {paymentLink && (
            <>
              <Text style={PARAGRAPH_STYLE}>
                Click below to pay your invoice:
              </Text>
              <Button href={paymentLink} style={BUTTON_STYLE}>
                Pay Invoice
              </Button>
            </>
          )}
          <Text style={PARAGRAPH_STYLE}>
            How did we do? Your feedback helps us improve:
          </Text>
          <Button href={reviewLink} style={BUTTON_STYLE}>
            Leave a Review
          </Button>
          <Text style={PARAGRAPH_STYLE}>
            Questions? Call us at {phoneNumber}.
          </Text>
          <Text style={FOOTER_STYLE}>
            {companyName}
          </Text>
        </div>
      </div>
    </Html>
  );
}

export function ReviewRequestEmail({
  customerName,
  serviceName,
  reviewLink,
  companyName,
}: ReviewRequestVars) {
  return (
    <Html lang="en">
      <div style={CONTAINER_STYLE}>
        <div style={CARD_STYLE}>
          <h1 style={HEADING_STYLE}>Quick Question</h1>
          <Text style={PARAGRAPH_STYLE}>
            Hi {customerName},
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            How was your recent {serviceName} with {companyName}?
          </Text>
          <Text style={PARAGRAPH_STYLE}>
            Your feedback helps us provide better service. It only takes a
            minute:
          </Text>
          <Button href={reviewLink} style={BUTTON_STYLE}>
            Leave a Review
          </Button>
          <Text style={FOOTER_STYLE}>
            Thank you for choosing {companyName}
          </Text>
        </div>
      </div>
    </Html>
  );
}

/**
 * Render an email template to HTML
 *
 * @param template - Email template component
 * @returns HTML string
 */
export async function renderEmailTemplate(
  template: React.ReactElement,
): Promise<string> {
  try {
    const html = await render(template);
    return html;
  } catch (error) {
    console.error("Email template rendering error:", error);
    throw new Error(
      `Failed to render email template: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
}

/**
 * Get email subject line for trigger type
 *
 * @param triggerType - Type of communication trigger
 * @param companyName - Company name for personalization
 * @returns Email subject line
 */
export function getEmailSubject(
  triggerType: keyof typeof templateVariableSchemas,
  companyName: string,
): string {
  const subjects: Record<
    keyof typeof templateVariableSchemas,
    string
  > = {
    appointment_scheduled: `Appointment Confirmed - ${companyName}`,
    appointment_reminder_24h: `Reminder: Upcoming Appointment - ${companyName}`,
    appointment_reminder_2h: `Technician On The Way - ${companyName}`,
    appointment_rescheduled: `Appointment Rescheduled - ${companyName}`,
    appointment_cancelled: `Appointment Cancelled - ${companyName}`,
    technician_enroute: `Technician Arriving Soon - ${companyName}`,
    technician_arrived: `Technician Has Arrived - ${companyName}`,
    job_completed: `Service Complete - ${companyName}`,
    review_request: `How was your service? - ${companyName}`,
    follow_up: `Follow Up: Your Recent Service - ${companyName}`,
    escalation: `Your Concern Has Been Escalated - ${companyName}`,
    estimate_sent: `Your Estimate Is Ready - ${companyName}`,
    payment_receipt: `Payment Received - ${companyName}`,
    invoice_overdue: `Reminder: Your Invoice Is Still Open - ${companyName}`,
  };

  return subjects[triggerType] || `Message from ${companyName}`;
}

// Import template variable types
import { templateVariableSchemas } from "./sms-templates";
type TemplateVariableTypes = typeof templateVariableSchemas;
