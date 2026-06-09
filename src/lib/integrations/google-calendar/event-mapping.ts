/**
 * PURE service_request -> Google Calendar event mapping.
 *
 * No DB, no network — given a request's decrypted, dispatcher-facing fields it
 * returns the {@link GoogleCalendarEvent} we push to Google. Two properties this
 * file guarantees and tests pin down:
 *
 *  1. TIMEZONE: the UTC arrival window is rendered as Eastern wall-clock
 *     (`dateTime` with NO offset) + an IANA `timeZone`, so Google anchors the
 *     event to America/New_York and stays DST-correct — never raw UTC.
 *  2. IDEMPOTENCY: `extendedProperties.private.requestId` carries the request
 *     id so a re-sync UPDATES the existing event rather than creating a
 *     duplicate.
 *
 * PII: the summary names the customer (the dispatcher already sees this on the
 * board), but the description is intentionally lean — issue, reference, urgency,
 * and access notes. Phone/email/address are included ONLY when explicitly
 * present, and the caller decides whether to pass them; nothing here logs.
 */
import {
  BUSINESS_TIME_ZONE,
  toBusinessWallClock,
} from "@/lib/admin/calendar-time";
import type { GoogleCalendarEvent, GoogleEventDateTime } from "./types";

/**
 * The slice of a service request the mapper needs. Decoupled from the DB row
 * type so the mapper stays pure and the test can construct fixtures freely.
 * All PII fields are already decrypted (or null) by the caller.
 */
export interface RequestEventInput {
  readonly id: string;
  readonly referenceNumber: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly description: string;
  /** UTC instant the arrival window starts. */
  readonly arrivalWindowStart: Date;
  /** UTC instant the arrival window ends. */
  readonly arrivalWindowEnd: Date;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly addressText: string | null;
  readonly accessNotes: string | null;
  readonly assignedToName: string | null;
}

/** Two-digit zero-pad for the local datetime string. */
function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * UTC instant -> Google `{ dateTime, timeZone }` in Eastern wall-clock. The
 * dateTime carries NO offset (e.g. "2026-06-09T08:00:00"); pairing it with the
 * IANA timeZone is what makes Google interpret it as Eastern and handle DST.
 */
export function toEasternEventDateTime(instant: Date): GoogleEventDateTime {
  const wall = toBusinessWallClock(instant);
  const dateTime =
    `${wall.year}-${pad(wall.month)}-${pad(wall.day)}` +
    `T${pad(wall.hour)}:${pad(wall.minute)}:00`;
  return { dateTime, timeZone: BUSINESS_TIME_ZONE };
}

/** Event title: customer + issue, falling back gracefully when name is absent. */
function buildSummary(input: RequestEventInput): string {
  const who = input.customerName?.trim() || "HVAC service";
  return `${who} — ${input.issueType}`;
}

/**
 * Event description. Field-labelled lines only, each emitted only when its value
 * is present — so an event never shows an empty "Phone:" line. PII is included
 * only for the fields the caller chose to pass through.
 */
function buildDescription(input: RequestEventInput): string {
  const lines: string[] = [
    `Reference: ${input.referenceNumber}`,
    `Issue: ${input.issueType}`,
    `Urgency: ${input.urgency}`,
  ];
  if (input.description.trim()) {
    lines.push(`Details: ${input.description.trim()}`);
  }
  if (input.assignedToName?.trim()) {
    lines.push(`Technician: ${input.assignedToName.trim()}`);
  }
  if (input.customerPhone?.trim()) {
    lines.push(`Phone: ${input.customerPhone.trim()}`);
  }
  if (input.addressText?.trim()) {
    lines.push(`Address: ${input.addressText.trim()}`);
  }
  if (input.accessNotes?.trim()) {
    lines.push(`Access: ${input.accessNotes.trim()}`);
  }
  return lines.join("\n");
}

/**
 * Map a request to the Google event we upsert. The request id is the
 * idempotency key, so re-syncing the same request always targets the same
 * event.
 */
export function serviceRequestToGoogleEvent(
  input: RequestEventInput,
): GoogleCalendarEvent {
  return {
    summary: buildSummary(input),
    description: buildDescription(input),
    start: toEasternEventDateTime(input.arrivalWindowStart),
    end: toEasternEventDateTime(input.arrivalWindowEnd),
    extendedProperties: {
      private: { requestId: input.id },
    },
  };
}
