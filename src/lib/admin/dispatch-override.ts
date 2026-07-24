/**
 * Override telemetry — record the human dispatcher's final pick against the
 * autopilot's decision row, the ground-truth label every tuning effort needs.
 *
 * Called from every HUMAN (re)assignment path (assignTechnician,
 * reassignTechnician, and the human placeAndAssignRequest path). Looks up the
 * request's LATEST REAL decision row (is_shadow=false, created_at DESC LIMIT 1) —
 * a shadow preview row is never stamped, else the human pick would poison the
 * tuning labels. When a real row exists and its chosen tech differs from the
 * human's pick, stamps the three override fields. Queued rows have
 * chosen_technician_id = NULL, so any human pick counts as a resolution label —
 * intentional. Last-write-wins: a later human reassignment overwrites the stamp.
 *
 * BEST-EFFORT: a second, non-batched write. Losing a label on a crash is
 * acceptable for telemetry — money-grade atomicity is deliberately NOT required.
 * Never throws; a failure is logged and swallowed so it can't fail the
 * assignment. The background auto-dispatch path passes no actor and never calls
 * this. Tenant-scoped on read and write.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dispatchDecisions } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { logger } from "@/lib/logger";

export async function stampDispatchOverride(
  organizationId: string,
  requestId: string,
  humanTechnicianId: string,
  actingUserId: string,
): Promise<void> {
  try {
    const [latest] = await db
      .select({
        id: dispatchDecisions.id,
        chosenTechnicianId: dispatchDecisions.chosenTechnicianId,
      })
      .from(dispatchDecisions)
      .where(
        withTenant(
          dispatchDecisions,
          organizationId,
          and(
            eq(dispatchDecisions.serviceRequestId, requestId),
            // Never stamp a shadow (autopilot-off preview) row: a human
            // assignment following a shadow decision must land on a REAL decision
            // row (or nothing), else it would poison the tuning labels.
            eq(dispatchDecisions.isShadow, false),
          )!,
        ),
      )
      .orderBy(desc(dispatchDecisions.createdAt))
      .limit(1);
    if (!latest) return;
    // No-op when the human picked exactly what autopilot chose — the decision was
    // NOT overridden, so there is nothing to label (and we skip the write).
    if (latest.chosenTechnicianId === humanTechnicianId) return;

    // Stamp only when the human's pick differs from what autopilot chose. A
    // queued row's chosen is NULL, so IS DISTINCT FROM fires for any human pick.
    // The SQL guard is defense-in-depth against a race with a concurrent stamp.
    await db
      .update(dispatchDecisions)
      .set({
        overriddenTechnicianId: humanTechnicianId,
        overriddenByUserId: actingUserId,
        overriddenAt: new Date(),
      })
      .where(
        withTenant(
          dispatchDecisions,
          organizationId,
          and(
            eq(dispatchDecisions.id, latest.id),
            sql`${dispatchDecisions.chosenTechnicianId} IS DISTINCT FROM ${humanTechnicianId}`,
          )!,
        ),
      );
  } catch (error) {
    logger.error(
      { error, serviceRequestId: requestId },
      "Failed to stamp dispatch override (non-fatal telemetry)",
    );
  }
}
