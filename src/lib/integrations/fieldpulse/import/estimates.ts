/**
 * Phase 9 — FieldPulse estimates inbound pull.
 *
 * importEstimatesFromFieldpulse pages the full /estimates list and upserts
 * each active record into the native estimates table, linked by fieldpulseEstimateId.
 *
 * Key decisions:
 *  - totalCount is NULL on /estimates (same as /invoices — Phase 9 live-verified);
 *    counts.total is set to null so the run ledger reflects "indeterminate".
 *  - Estimate status mapping: FP status is a free string. Best-effort map to the
 *    native estimateStatusEnum ("open"|"sold"|"dismissed"|"expired"):
 *      "1","draft","open" → "open"
 *      "2","approved","sold","accepted" → "sold"
 *      "3","void","declined","dismissed","rejected" → "dismissed"
 *      "4","expired" → "expired"
 *      unknown → "open" (safe default; tallied + logged once at end)
 *  - FP estimates are SYNCED-READ-ONLY in native money flows (fieldpulseEstimateId
 *    IS NOT NULL discriminator — same pattern as invoices).
 *  - Money (subtotalCents, taxCents, totalCents) in cents from the client mapper.
 *  - customer link: resolved by fieldpulseCustomerId on the customers table;
 *    null if not found (degrade, do not skip).
 *  - job link (serviceRequestId): resolved by fieldpulseJobId on service_requests;
 *    null if not found (degrade, do not skip).
 *  - Pre-select Set for exact created/updated classification.
 *  - Per-record containment: errors++ and continue, never abort.
 *  - Soft-deleted estimates: skipped (skipped++).
 *  - No encryption: estimate fields are operational/non-PII (notes, dates) — no
 *    encrypt() call, mirroring the schema's plaintext columns for estimates.
 *  - Upsert on (org, fieldpulseEstimateId) using the partial unique index conflict
 *    target.
 */
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { estimates, serviceRequests, customers } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { FieldpulseClient } from "../client";
import type { FieldpulseEstimate } from "../types";
import type { PhaseResult } from "./run-import";
import { parseFpDate } from "./jobs";

export function mapFpEstimateStatus(
  fpStatus: string | null | undefined,
): "open" | "sold" | "dismissed" | "expired" {
  const s = (fpStatus ?? "").toLowerCase().trim();
  if (["1", "draft", "open"].includes(s)) return "open";
  if (["2", "approved", "sold", "accepted"].includes(s)) return "sold";
  if (["3", "void", "declined", "dismissed", "rejected"].includes(s)) return "dismissed";
  if (["4", "expired"].includes(s)) return "expired";
  return "open"; // safe default for unknowns
}

export async function importEstimatesFromFieldpulse(
  orgId: string,
  counts: PhaseResult,
  client: FieldpulseClient,
): Promise<void> {
  const { items, totalCount } = await client.listEstimates();
  counts.fetched = items.length;
  counts.total = totalCount ?? null; // always null per Phase-9 (same as /invoices)

  // Pre-select existing fieldpulseEstimateIds for this org.
  const existingRows = await db
    .select({ fieldpulseEstimateId: estimates.fieldpulseEstimateId })
    .from(estimates)
    .where(
      and(
        eq(estimates.organizationId, orgId),
        isNotNull(estimates.fieldpulseEstimateId),
      ),
    );
  const existingFpIds = new Set(existingRows.map((r) => r.fieldpulseEstimateId as string));

  // Pre-select customers by fieldpulseCustomerId → native id.
  const customerRows = await db
    .select({ fpId: customers.fieldpulseCustomerId, nativeId: customers.id })
    .from(customers)
    .where(and(eq(customers.organizationId, orgId), isNotNull(customers.fieldpulseCustomerId)));
  const customerMap = new Map(customerRows.map((r) => [r.fpId as string, r.nativeId]));

  // Pre-select service_requests by fieldpulseJobId → native id.
  const jobRows = await db
    .select({ fpId: serviceRequests.fieldpulseJobId, nativeId: serviceRequests.id })
    .from(serviceRequests)
    .where(and(eq(serviceRequests.organizationId, orgId), isNotNull(serviceRequests.fieldpulseJobId)));
  const jobMap = new Map(jobRows.map((r) => [r.fpId as string, r.nativeId]));

  const unknownStatuses = new Map<string, number>();

  for (const est of items) {
    if (est.deletedAt != null) {
      counts.skipped++;
      continue;
    }

    try {
      const isNew = !existingFpIds.has(est.id);
      const status = mapFpEstimateStatus(est.status);

      // Tally unknown statuses.
      if (est.status != null) {
        const s = est.status.toLowerCase().trim();
        const known = ["1", "draft", "open", "2", "approved", "sold", "accepted", "3", "void", "declined", "dismissed", "rejected", "4", "expired"];
        if (!known.includes(s)) {
          unknownStatuses.set(est.status, (unknownStatuses.get(est.status) ?? 0) + 1);
        }
      }

      const customerId = est.customerId ? (customerMap.get(est.customerId) ?? null) : null;
      const serviceRequestId = est.jobId ? (jobMap.get(est.jobId) ?? null) : null;

      await db
        .insert(estimates)
        .values({
          organizationId: orgId,
          fieldpulseEstimateId: est.id,
          customerId: customerId ?? undefined,
          serviceRequestId: serviceRequestId ?? undefined,
          status,
          totalCents: est.totalCents ?? 0,
          createdAt: parseFpDate(est.createdAt) ?? undefined,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [estimates.organizationId, estimates.fieldpulseEstimateId],
          targetWhere: sql`${estimates.fieldpulseEstimateId} IS NOT NULL`,
          set: {
            customerId: customerId ?? undefined,
            serviceRequestId: serviceRequestId ?? undefined,
            status,
            totalCents: est.totalCents ?? 0,
            updatedAt: new Date(),
          },
        });

      if (isNew) {
        existingFpIds.add(est.id);
        counts.created++;
      } else {
        counts.updated++;
      }
    } catch (err) {
      counts.errors++;
      logger.error(
        {
          orgId,
          fpEstimateId: est.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "FP estimate import: per-record error (continuing)",
      );
    }
  }

  if (unknownStatuses.size > 0) {
    logger.warn(
      { orgId, unknownStatuses: Object.fromEntries(unknownStatuses) },
      "FP estimate import: unknown FP status codes encountered — mapped to 'open'",
    );
  }

  if (counts.errors > 0) {
    logger.warn(
      { orgId, errors: counts.errors, fetched: counts.fetched },
      "FP estimate import: completed with per-record errors — check logs above for details",
    );
  }
}

export type { FieldpulseEstimate };
