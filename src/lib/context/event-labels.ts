/**
 * Pure, PII-free renderer for customer-thread event labels (Probook v3, Phase 1).
 *
 * Reads ONLY the structured fields on a CustomerEventView (closed enums +
 * label-key + jobType/window). It NEVER dereferences refId or any free text, so
 * the output is guaranteed to contain no PII. Unknown/null labels fall back to a
 * generic phrase. The switch is exhaustive with a compile-time `never` guard.
 */

/** Closed set of event kinds recorded on a customer thread. */
export type EventKind =
  | "call"
  | "sms_in"
  | "sms_out"
  | "web_msg"
  | "booking"
  | "status_change"
  | "outbound"
  | "forecast_note"
  | "note";

/** Closed set of label keys a renderer can map to a human phrase. */
export type EventLabelKey =
  | "booked"
  | "reassigned"
  | "completed"
  | "cancelled"
  | "sms_in"
  | "sms_out"
  | "web_msg"
  | "call_in"
  | "outbound_sent"
  | "quality_missing_address"
  | "quality_dup_suspected"
  | "forecast_note";

/** The structured (PII-free) projection a renderer is allowed to read. */
export interface CustomerEventView {
  readonly kind: EventKind;
  readonly labelKey: EventLabelKey | null;
  readonly jobType: string | null;
  readonly window: string | null;
  readonly refId: string | null;
}

/** Render a PII-free human label from structured event fields only. */
export function renderEventLabel(e: CustomerEventView): string {
  switch (e.labelKey) {
    case "booked":
      if (e.jobType && e.window) return `Booked ${e.jobType} (${e.window})`;
      if (e.jobType) return `Booked ${e.jobType}`;
      return "Booking recorded";
    case "reassigned":
      return e.jobType ? `Job reassigned (${e.jobType})` : "Job reassigned";
    case "completed":
      return e.jobType ? `Job completed (${e.jobType})` : "Job completed";
    case "cancelled":
      return e.jobType ? `Job cancelled (${e.jobType})` : "Job cancelled";
    case "sms_in":
      return "Inbound text";
    case "sms_out":
      return "Text sent";
    case "web_msg":
      return "Web chat message";
    case "call_in":
      return "Inbound call";
    case "outbound_sent":
      return "Outbound message sent";
    case "quality_missing_address":
      return "Flagged: missing address";
    case "quality_dup_suspected":
      return "Flagged: possible duplicate";
    case "forecast_note":
      return "Forecast note";
    case null:
      return "Activity recorded";
    default: {
      const _exhaustive: never = e.labelKey;
      void _exhaustive;
      return "Activity recorded";
    }
  }
}
