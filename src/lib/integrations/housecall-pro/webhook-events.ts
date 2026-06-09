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
  const hcpJobId = typeof data.id === "string" ? data.id : null;
  return { eventId, eventType, hcpJobId };
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
