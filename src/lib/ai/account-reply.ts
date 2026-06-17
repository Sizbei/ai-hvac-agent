/**
 * Deterministic, pricing-safe reply assembly for the identified-customer account
 * tools (src/lib/ai/account-tools.ts). Pure functions: take a tool result, return
 * the customer-facing string. Money is formatted cents->dollars HERE (the reply
 * layer), and dates are rendered in the business timezone.
 *
 * GUARDRAILS honored:
 *  - never-promise-pricing: the balance reply states an EXISTING invoice balance
 *    (a past-transaction fact). No estimate/quote/future price is ever produced.
 *  - never say booked/scheduled/confirmed for a reschedule: the reschedule reply
 *    is a HAND-OFF acknowledgement ("our team will follow up"), never a booking.
 *  - PII-free: no name/address/email is interpolated into these replies.
 */
import { formatCentsExact } from "@/lib/admin/money-format";
import { BUSINESS_TIME_ZONE } from "@/lib/admin/calendar-time";
import type {
  MembershipSummary,
  NextVisit,
  OpenBalance,
  UpcomingAppointment,
  RescheduleHandoff,
} from "@/lib/ai/account-tools";

/** "Monday, June 16" in the business timezone, or null when undated. */
function formatDay(date: Date | null): string | null {
  if (!date) return null;
  return date.toLocaleDateString("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

/** "8:00 AM" in the business timezone. */
function formatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    timeZone: BUSINESS_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Human label for a request status. */
function statusLabel(status: string): string {
  switch (status) {
    case "scheduled":
      return "scheduled";
    case "assigned":
      return "assigned to a technician";
    case "in_progress":
      return "in progress";
    case "on_hold":
      return "on hold";
    case "pending":
    default:
      return "being scheduled";
  }
}

export function membershipReply(summary: MembershipSummary): string {
  if (!summary.isMember) {
    return "You're not currently on one of our maintenance plans. Would you like our team to tell you what's included?";
  }
  const plan = summary.planName ?? "a maintenance plan";
  const renews = summary.currentPeriodEnd
    ? ` Your current period runs through ${formatDay(summary.currentPeriodEnd)}.`
    : "";
  return `Yes — you're an active member on ${plan}.${renews}`;
}

export function nextVisitReply(visit: NextVisit | null): string {
  if (!visit) {
    return "I don't see an upcoming maintenance visit on your account right now. Our team can help you get one set up — would you like that?";
  }
  return `Your next maintenance visit is set for ${formatDay(visit.dueDate)}. Our team will reach out to coordinate the exact timing.`;
}

export function balanceReply(balance: OpenBalance): string {
  const portal = balance.hasPortalLink
    ? " You can also view and pay it from your customer portal link."
    : "";
  if (balance.openInvoiceCount === 0 || balance.balanceCents === 0) {
    return "Good news — you don't have any open balance on your account right now.";
  }
  const amount = formatCentsExact(balance.balanceCents);
  const invoiceWord =
    balance.openInvoiceCount === 1 ? "invoice" : "invoices";
  return `You have a balance of ${amount} across ${balance.openInvoiceCount} open ${invoiceWord}.${portal}`;
}

export function appointmentReply(appointment: UpcomingAppointment | null): string {
  if (!appointment) {
    return "I don't see an upcoming appointment on your account right now. Would you like to start a new request?";
  }
  const day = formatDay(appointment.scheduledDate);
  const window =
    appointment.arrivalWindowStart && appointment.arrivalWindowEnd
      ? ` with an arrival window of ${formatTime(appointment.arrivalWindowStart)}–${formatTime(appointment.arrivalWindowEnd)}`
      : "";
  if (day) {
    return `Your appointment (${appointment.referenceNumber}) is ${statusLabel(appointment.status)} for ${day}${window}. Our team will reach out if anything changes.`;
  }
  return `Your request (${appointment.referenceNumber}) is ${statusLabel(appointment.status)}. Our team will reach out to coordinate the timing.`;
}

export function rescheduleReply(handoff: RescheduleHandoff): string {
  if (!handoff.recorded) {
    return "I don't see an upcoming appointment to reschedule, but I've flagged this so our team can reach out and help.";
  }
  return `I've passed your reschedule request for ${handoff.referenceNumber} to our team — someone will follow up to find a new time that works. I can't change the time myself, but they'll take care of it.`;
}
