/**
 * Scheduling-source SEAM.
 *
 * The calendar needs two facts about a technician's day: their AVAILABILITY
 * (working-hour windows) and their booked JOBS (arrival windows already taken).
 * Both come from our own database today — see the DB-backed implementation
 * below, which delegates to scheduling-queries.ts.
 *
 * ┌─ HCP SEAM ────────────────────────────────────────────────────────────────┐
 * │ A live Housecall Pro integration is BLOCKED on the customer's MAX-plan API │
 * │ key. When that key is available, an HCP-backed SchedulingSource can be     │
 * │ written (fetching availability + jobs from the HCP API) and swapped in     │
 * │ without touching the calendar UI or the conflict/slot logic that consume   │
 * │ this interface. Keep this interface MINIMAL: add to it only when a new     │
 * │ caller genuinely needs another fact from the source.                       │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
import type { AvailabilitySlot, ScheduledJob } from "./types";
import {
  getTechnicianAvailability,
  getScheduledJobsForRange,
} from "./scheduling-queries";

/**
 * A source of scheduling truth for one organization. Today this is our DB;
 * tomorrow it could be Housecall Pro. Every method is tenant-scoped by the
 * `organizationId` the source is constructed with.
 */
export interface SchedulingSource {
  /**
   * Recurring weekly working-hour windows. Pass a `technicianId` to scope to one
   * technician, or omit it for every technician in the org.
   */
  getAvailability(
    technicianId?: string,
  ): Promise<readonly AvailabilitySlot[]>;

  /**
   * Jobs with a concrete arrival window overlapping [startIso, endIso) — the
   * booked time a technician's day is already committed to.
   */
  getJobs(
    startIso: string,
    endIso: string,
  ): Promise<readonly ScheduledJob[]>;
}

/**
 * DB-backed SchedulingSource: reads availability + jobs from our own tables via
 * scheduling-queries (all tenant-scoped via withTenant). This is the default and
 * only implementation until HCP credentials unblock an HCP-backed source.
 */
export class DbSchedulingSource implements SchedulingSource {
  constructor(private readonly organizationId: string) {}

  getAvailability(
    technicianId?: string,
  ): Promise<readonly AvailabilitySlot[]> {
    return getTechnicianAvailability(this.organizationId, technicianId);
  }

  getJobs(
    startIso: string,
    endIso: string,
  ): Promise<readonly ScheduledJob[]> {
    return getScheduledJobsForRange(this.organizationId, startIso, endIso);
  }
}

/**
 * Resolve the active scheduling source for an org. A single seam: when an
 * HCP-backed source ships, branch here on org config (e.g. "has HCP key") and
 * return the HCP source instead — no caller changes.
 */
export function getSchedulingSource(
  organizationId: string,
): SchedulingSource {
  return new DbSchedulingSource(organizationId);
}
