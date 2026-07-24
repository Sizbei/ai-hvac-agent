/**
 * Read the recorded dispatch decision for a request — the "why this tech?" data.
 * Latest row (created_at DESC LIMIT 1), tenant-scoped. The candidates JSONB stores
 * tech UUIDs only, so we resolve display names with ONE org-scoped inArray lookup
 * over users. skillMatched is read straight from the STORED candidate field
 * (recorded by recordDispatchDecision) — never re-derived from reason text. Rows
 * recorded before that field existed lack the key: we surface it as `null`
 * (unknown) rather than guessing. Read-only.
 */
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { dispatchDecisions, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";

export interface DispatchDecisionCandidate {
  readonly technicianId: string;
  readonly name: string | null;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly travelKm: number | null;
  readonly travelMinutes: number | null;
  /** true/false from the stored candidate; null for legacy rows recorded before
   * skillMatched was stored (unknown — the panel renders no indicator). */
  readonly skillMatched: boolean | null;
}

export interface DispatchDecisionView {
  readonly outcome: string;
  readonly isShadow: boolean;
  readonly chosenTechnicianId: string | null;
  readonly topScore: number | null;
  readonly confidenceGap: number | null;
  readonly createdAt: string;
  readonly overriddenTechnicianId: string | null;
  readonly overriddenByUserId: string | null;
  readonly overriddenAt: string | null;
  readonly candidates: readonly DispatchDecisionCandidate[];
}

export async function getDispatchDecisionForRequest(
  organizationId: string,
  requestId: string,
): Promise<DispatchDecisionView | null> {
  const [row] = await db
    .select({
      outcome: dispatchDecisions.outcome,
      isShadow: dispatchDecisions.isShadow,
      chosenTechnicianId: dispatchDecisions.chosenTechnicianId,
      topScore: dispatchDecisions.topScore,
      confidenceGap: dispatchDecisions.confidenceGap,
      candidates: dispatchDecisions.candidates,
      createdAt: dispatchDecisions.createdAt,
      overriddenTechnicianId: dispatchDecisions.overriddenTechnicianId,
      overriddenByUserId: dispatchDecisions.overriddenByUserId,
      overriddenAt: dispatchDecisions.overriddenAt,
    })
    .from(dispatchDecisions)
    .where(
      withTenant(
        dispatchDecisions,
        organizationId,
        eq(dispatchDecisions.serviceRequestId, requestId),
      ),
    )
    .orderBy(desc(dispatchDecisions.createdAt))
    .limit(1);

  if (!row) return null;

  const rawCandidates = row.candidates ?? [];
  const techIds = [...new Set(rawCandidates.map((c) => c.technicianId))];
  const nameById = new Map<string, string>();
  if (techIds.length > 0) {
    const nameRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(withTenant(users, organizationId, inArray(users.id, techIds)));
    for (const n of nameRows) nameById.set(n.id, n.name);
  }

  const candidates: DispatchDecisionCandidate[] = rawCandidates.map((c) => ({
    technicianId: c.technicianId,
    name: nameById.get(c.technicianId) ?? null,
    score: c.score,
    reasons: c.reasons,
    travelKm: c.travelKm ?? null,
    travelMinutes: c.travelMinutes ?? null,
    // Read the STORED flag; absent (legacy row) → null (unknown, not guessed).
    skillMatched: typeof c.skillMatched === "boolean" ? c.skillMatched : null,
  }));

  return {
    outcome: row.outcome,
    isShadow: row.isShadow,
    chosenTechnicianId: row.chosenTechnicianId,
    topScore: row.topScore,
    confidenceGap: row.confidenceGap,
    createdAt: row.createdAt.toISOString(),
    overriddenTechnicianId: row.overriddenTechnicianId,
    overriddenByUserId: row.overriddenByUserId,
    overriddenAt: row.overriddenAt ? row.overriddenAt.toISOString() : null,
    candidates,
  };
}
