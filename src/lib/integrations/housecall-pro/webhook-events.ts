/**
 * PURE parsing + status-mapping for inbound Housecall Pro webhooks. (Stage 5.)
 *
 * No DB, no network, no crypto — given an untrusted parsed JSON body it narrows
 * it to a typed event and maps the HCP event type to OUR request-status state
 * machine target. Kept separate from the route + sync so the mapping stays
 * unit-testable without touching HTTP, the DB, or HCP.
 *
 * HCP webhook envelope (verified against docs.housecallpro.com): a JSON object
 * with `id` (the event id — our idempotency key), `event` (the type string,
 * e.g. "job.completed"), `created_at`, and `data` (the event-specific resource).
 * For job events `data` is the job, carrying `id` (the HCP job id we mapped at
 * push time) and `work_status`. HCP may add event types, so an unknown `event`
 * is parsed successfully but maps to no transition (the handler records it as
 * seen and no-ops rather than crashing).
 */
import type { RequestStatus } from "@/lib/admin/request-status";

/** The HCP job-status webhook event types we act on (verified vs HCP docs). */
export const HCP_JOB_EVENT_TYPES = [
  "job.created",
  "job.scheduled",
  "job.started",
  "job.on_my_way",
  "job.completed",
  "job.canceled",
  "job.paid",
  "job.deleted",
] as const;

/**
 * The HCP invoice webhook event types we mirror onto a request's invoiceStatus.
 * The invoice carries a `job_id` linking it back to the HCP job we mapped at
 * push time (so we can find OUR service_request by hcpJobId). (Stage 4.)
 */
export const HCP_INVOICE_EVENT_TYPES = [
  "invoice.sent",
  "invoice.paid",
  "invoice.voided",
] as const;

/** OUR invoice/payment status target for a service request (matches the DB enum). */
export type InvoiceStatus = "sent" | "paid" | "void";

/**
 * A narrowed HCP webhook event. `eventType` is kept as a free string (not a
 * union) so an unrecognized type never fails parsing — we still record it for
 * idempotency and audit, we just don't transition on it.
 */
export interface HcpWebhookEvent {
  /** HCP event id — the idempotency key (dedupe redeliveries on this). */
  readonly eventId: string;
  /** HCP event type, e.g. "job.completed". */
  readonly eventType: string;
  /** The HCP job id this event references, or null for non-job events. */
  readonly hcpJobId: string | null;
  /**
   * The HCP invoice id — set ONLY for an `invoice.*` event (its resource `id`),
   * null otherwise. Drives the money-grade pull into the native `invoices` table.
   */
  readonly hcpInvoiceId: string | null;
}

/**
 * Narrow an untrusted parsed webhook body to {@link HcpWebhookEvent}, or null
 * when it's malformed (missing id/event). Tolerant of HCP omitting the job id on
 * a non-job event — that's null, not a parse failure. Never throws.
 */
export function parseWebhookEvent(raw: unknown): HcpWebhookEvent | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const eventId = typeof obj.id === "string" ? obj.id : null;
  const eventType = typeof obj.event === "string" ? obj.event : null;
  if (!eventId || !eventType) {
    return null;
  }
  const data =
    typeof obj.data === "object" && obj.data !== null
      ? (obj.data as Record<string, unknown>)
      : {};
  // The HCP job id this event references. For a job event the resource in `data`
  // IS the job, so its `id` is the job id. For an invoice event the resource is
  // the invoice (its `id` is the invoice id), which carries `job_id` linking it
  // back to the job we mapped at push time — that's what we key on. Prefer an
  // explicit `job_id` when present, else fall back to the resource `id`.
  const hcpJobId =
    typeof data.job_id === "string"
      ? data.job_id
      : typeof data.id === "string"
        ? data.id
        : null;
  // For an invoice event the resource `id` IS the invoice id (the money-pull
  // target). Null for every non-invoice event.
  const hcpInvoiceId =
    eventType.startsWith("invoice.") && typeof data.id === "string"
      ? data.id
      : null;
  return { eventId, eventType, hcpJobId, hcpInvoiceId };
}

/**
 * Map an HCP job event to the request-status transition target it should drive,
 * or null when the event implies no status change (or is unknown). We map
 * lifecycle-bearing events only:
 *
 *   - job.started / job.on_my_way → in_progress (a tech is actively on it)
 *   - job.completed               → completed
 *   - job.canceled / job.deleted  → cancelled
 *   - job.scheduled               → scheduled (HCP booked/rebooked a window)
 *
 * job.created and job.paid carry no status meaning for our lifecycle (we author
 * creation ourselves at push time; payment isn't a request status), so they map
 * to null and the handler no-ops on them. The state machine still has the final
 * say — an illegal edge from the request's CURRENT status is rejected there, so
 * an out-of-order webhook can never force an invalid transition.
 */
export function eventTypeToStatus(eventType: string): RequestStatus | null {
  switch (eventType) {
    case "job.scheduled":
      return "scheduled";
    case "job.started":
    case "job.on_my_way":
      return "in_progress";
    case "job.completed":
      return "completed";
    case "job.canceled":
    case "job.deleted":
      return "cancelled";
    default:
      return null;
  }
}

/**
 * Map an HCP invoice event to OUR invoice/payment status, or null when the event
 * carries no invoice-status meaning (or is unknown). Pure; the sync layer uses
 * this to set the matching request's invoiceStatus:
 *
 *   - invoice.sent   → 'sent'
 *   - invoice.paid   → 'paid'
 *   - invoice.voided → 'void'
 *
 * Anything else maps to null and the handler records it + no-ops (degrade-safe).
 * The existing job.* status mapping (eventTypeToStatus) is untouched — these two
 * mappers are independent, so a job event never yields an invoice status and an
 * invoice event never yields a request-status transition.
 */
export function eventTypeToInvoiceStatus(
  eventType: string,
): InvoiceStatus | null {
  switch (eventType) {
    case "invoice.sent":
      return "sent";
    case "invoice.paid":
      return "paid";
    case "invoice.voided":
      return "void";
    default:
      return null;
  }
}
