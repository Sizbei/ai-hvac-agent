/**
 * PURE service_request -> Housecall Pro job-field mapping.
 *
 * No DB, no network — given a request's decrypted, dispatcher-facing fields it
 * returns the description + ISO-UTC schedule we send to HCP on create/update.
 * Kept separate from job-sync.ts so the field shaping stays unit-testable without
 * touching HCP or the DB.
 *
 * TIMEZONE: HCP accepts ISO-8601 timestamps and stores the instant; the app
 * persists arrival windows as UTC and renders Eastern, so the boundary to HCP
 * stays UTC (the raw ISO of the stored instant). HCP renders it in the account's
 * own timezone — we don't double-convert here.
 *
 * PII: the description carries the issue, reference, urgency, address and access
 * notes a tech needs on-site. Each labelled line is emitted only when its value
 * is present, and the caller decides what to pass through; nothing here logs.
 *
 * LINE ITEMS: alongside the description, the mapper also emits structured HCP
 * line items (see line-items.ts). These are DESCRIPTIVE only — they carry NO
 * prices (this business prices on-site). The description behavior is unchanged.
 */
import { buildLineItemsFromRequest } from "./line-items";
import type { HousecallLineItem } from "./types";

/**
 * The slice of a service request the mapper needs. Decoupled from the DB row
 * type so the mapper stays pure and tests can build fixtures freely. PII fields
 * are already decrypted (or null) by the caller.
 */
export interface RequestJobInput {
  readonly referenceNumber: string;
  readonly issueType: string;
  readonly urgency: string;
  readonly description: string;
  /** UTC instant the arrival window starts, or null when unscheduled. */
  readonly arrivalWindowStart: Date | null;
  /** UTC instant the arrival window ends, or null when unscheduled. */
  readonly arrivalWindowEnd: Date | null;
  readonly addressText: string | null;
  readonly accessNotes: string | null;
  /** Work classification enum value (e.g. "no_cool"); feeds line items. */
  readonly jobType?: string | null;
  /** HVAC system enum value (e.g. "central_ac"); feeds line items. */
  readonly systemType?: string | null;
}

/**
 * The mapped HCP job fields: a human description plus an optional ISO-UTC
 * schedule (omitted when the request has no arrival window yet). Shared by the
 * create and update paths in job-sync.ts.
 */
export interface MappedJobFields {
  readonly description: string;
  /** ISO-8601 UTC, present only when the request has an arrival window. */
  readonly scheduleStart?: string;
  /** ISO-8601 UTC. */
  readonly scheduleEnd?: string;
  /**
   * Structured, DESCRIPTIVE line items derived from the intake (no prices).
   * Present only when at least one item could be derived; omitted otherwise.
   */
  readonly lineItems?: readonly HousecallLineItem[];
}

/**
 * Build the HCP job description. Field-labelled lines, each emitted only when
 * present — so a job never shows an empty "Access:" line. PII is included only
 * for the fields the caller passes through.
 */
function buildDescription(input: RequestJobInput): string {
  const lines: string[] = [
    `Reference: ${input.referenceNumber}`,
    `Issue: ${input.issueType}`,
    `Urgency: ${input.urgency}`,
  ];
  if (input.description.trim()) {
    lines.push(`Details: ${input.description.trim()}`);
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
 * Map a request to the HCP job fields. The schedule is included only when BOTH
 * window bounds are present (an unscheduled request is pushed without a
 * schedule). Times are the raw ISO-8601 UTC of the stored instants.
 */
export function serviceRequestToJobFields(
  input: RequestJobInput,
): MappedJobFields {
  const description = buildDescription(input);
  // Build descriptive line items alongside the description (no prices). Omit the
  // field entirely when nothing could be derived, so the create body stays clean.
  const derived = buildLineItemsFromRequest({
    issueType: input.issueType,
    jobType: input.jobType,
    systemType: input.systemType,
    accessNotes: input.accessNotes,
  });
  const lineItems = derived.length > 0 ? derived : undefined;
  if (input.arrivalWindowStart && input.arrivalWindowEnd) {
    return {
      description,
      scheduleStart: input.arrivalWindowStart.toISOString(),
      scheduleEnd: input.arrivalWindowEnd.toISOString(),
      lineItems,
    };
  }
  return { description, lineItems };
}
