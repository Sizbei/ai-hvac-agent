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
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logger } from "@/lib/logger";
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

  /**
   * The ids of the bookable technicians whose hours count toward capacity. These
   * are the ids the availability/jobs rows are keyed by — for the DB source they
   * are our active `users` rows; for an HCP source they are the synthetic, opaque
   * roster derived from HCP's bookable windows (no HCP staff identity). Lives on
   * the seam so the open-window aggregation can scope to "bookable staff" from
   * WHICHEVER source is active, without the consumer knowing which.
   */
  getActiveTechnicianIds(): Promise<readonly string[]>;
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

  /** Active technicians for the org — bookable staff whose hours count toward
   * capacity. Ids only (no names), so nothing PII flows into the aggregation. */
  async getActiveTechnicianIds(): Promise<readonly string[]> {
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(
        withTenant(
          users,
          this.organizationId,
          eq(users.role, "technician"),
          eq(users.isActive, true),
        ),
      );
    return rows.map((row) => row.id);
  }
}

/**
 * Resolve the ACTIVE scheduling source for an org.
 *
 * Returns the HCP-backed source when the org is connected to Housecall Pro (a
 * stored, encrypted API key resolves a live client); otherwise the DB source —
 * the default and the universal fallback. Selection is the single seam: callers
 * (getOpenAvailability, the calendar) consume the returned SchedulingSource
 * transparently and never know which backend answered.
 *
 * DEGRADE SAFELY: any failure RESOLVING the HCP source (no client, or an error
 * while probing connectedness) falls through to the DB source so a remote hiccup
 * never fails the customer's slot-pick. The HCP modules are imported dynamically
 * to avoid a static admin↔integrations import cycle (the HCP source imports this
 * file's SchedulingSource type).
 *
 * Async because resolving HCP-connectedness reads the (encrypted) connection
 * row; the DB source needs no I/O to construct but the signature is uniform.
 */
export async function getSchedulingSource(
  organizationId: string,
): Promise<SchedulingSource> {
  try {
    const [{ getHousecallClient }, { HcpSchedulingSource }] = await Promise.all([
      import("@/lib/integrations/housecall-pro/client"),
      import("@/lib/integrations/housecall-pro/scheduling-source"),
    ]);
    const client = await getHousecallClient(organizationId);
    if (client) {
      return new HcpSchedulingSource(organizationId, client);
    }
  } catch (error: unknown) {
    // Never let an HCP-resolution problem break scheduling: log and fall back.
    logger.warn(
      {
        organizationId,
        error: error instanceof Error ? error.message : "unknown",
      },
      "Falling back to DB scheduling source",
    );
  }
  return new DbSchedulingSource(organizationId);
}
