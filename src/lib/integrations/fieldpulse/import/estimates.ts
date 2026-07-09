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
import { estimates, estimateOptions, estimateLineItems, serviceRequests, customers } from "@/lib/db/schema";
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
  const { items, totalCount, cappedByMaxPages } = await client.listEstimates();
  counts.fetched = items.length;
  counts.total = totalCount ?? null; // always null per Phase-9 (same as /invoices)

  if (cappedByMaxPages) {
    logger.warn(
      {
        orgId,
        fetched: items.length,
        note: "Walk exhausted maxPages on a full page — possible truncation; raise maxPages or investigate",
      },
      "FP estimates import: walk may be incomplete (cappedByMaxPages=true)",
    );
    (counts as unknown as Record<string, unknown>).cappedNote = "cappedByMaxPages";
  }

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

      // Per-id enrichment to get custom_status (not present on list rows).
      let fieldpulseStatusName: string | null = null;
      try {
        const detail = await client.getEstimate(est.id);
        fieldpulseStatusName = detail?.customStatus ?? null;
      } catch (enrichErr) {
        logger.warn(
          { orgId, fpEstimateId: est.id, error: enrichErr instanceof Error ? enrichErr.message : String(enrichErr) },
          "FP estimate import: per-id enrichment failed — continuing with null status name",
        );
      }

      const upserted = await db
        .insert(estimates)
        .values({
          organizationId: orgId,
          fieldpulseEstimateId: est.id,
          customerId: customerId ?? undefined,
          serviceRequestId: serviceRequestId ?? undefined,
          status,
          totalCents: est.totalCents ?? 0,
          fieldpulseStatusName,
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
            fieldpulseStatusName,
            updatedAt: new Date(),
          },
        })
        .returning({ id: estimates.id });

      const estimateId = upserted[0]?.id;

      // Upsert line items via a synthetic "FieldPulse" option.
      if (estimateId && est.lineItems && est.lineItems.length > 0) {
        // Find or create the synthetic option for this estimate.
        const existingOptions = await db
          .select({ id: estimateOptions.id })
          .from(estimateOptions)
          .where(
            and(
              eq(estimateOptions.organizationId, orgId),
              eq(estimateOptions.estimateId, estimateId),
              eq(estimateOptions.name, "FieldPulse"),
            ),
          );

        let optionId: string;
        if (existingOptions.length > 0) {
          optionId = existingOptions[0].id;
          // Re-import: refresh totals from the fresh FP values so a price change
          // in FieldPulse is reflected here on the next nightly sweep.
          await db
            .update(estimateOptions)
            .set({
              subtotalCents: est.subtotalCents ?? 0,
              taxCents: est.taxCents ?? 0,
              totalCents: est.totalCents ?? 0,
            })
            .where(eq(estimateOptions.id, optionId));
        } else {
          const inserted = await db
            .insert(estimateOptions)
            .values({
              organizationId: orgId,
              estimateId,
              name: "FieldPulse",
              sortOrder: 0,
              subtotalCents: est.subtotalCents ?? 0,
              taxCents: est.taxCents ?? 0,
              totalCents: est.totalCents ?? 0,
            })
            .returning({ id: estimateOptions.id });
          if (!inserted[0]) {
            throw new Error("FP estimate option insert returned no row");
          }
          optionId = inserted[0].id;
        }

        // Build line item rows.
        const liRows = est.lineItems.map((li) => ({
          organizationId: orgId,
          optionId,
          name: li.name,
          quantity: Math.max(1, Math.round(li.quantity)),
          unitPriceCents: li.unitPriceCents,
          costCents: Math.round(li.quantity * li.unitCostCents),
          lineTotalCents: Math.round(li.quantity * li.unitPriceCents),
        }));

        // Replace line items atomically (delete + insert).
        await db.batch([
          db.delete(estimateLineItems).where(
            and(
              eq(estimateLineItems.organizationId, orgId),
              eq(estimateLineItems.optionId, optionId),
            ),
          ),
          db.insert(estimateLineItems).values(liRows),
        ]);
      }

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
