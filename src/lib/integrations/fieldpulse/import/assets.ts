/**
 * Phase 9 — FieldPulse assets inbound pull.
 *
 * importAssetsFromFieldpulse pages the full /assets list and upserts each
 * active record into the native customer_equipment table, linked by fieldpulseAssetId.
 *
 * Key decisions:
 *  - customerId is REQUIRED — skip without it (customer link is required by schema).
 *  - assetType mapping: FP free-text → native equipmentTypeEnum ("ac"|"furnace"|
 *    "heat_pump"|"boiler"|"mini_split"|"thermostat"|"other"). Best-effort match
 *    on lowercased contains; unknown → "other".
 *  - install_date parsed via parseFpDate (shared utility from jobs.ts).
 *  - title → notes column (no `name` column on customer_equipment; closest fit).
 *  - tag → serialNumber column.
 *  - locationDescription → locationInHome column.
 *  - No encryption: customer_equipment fields are operational (not PII) — no
 *    encrypt() call needed.
 *  - Pre-select: customers by fieldpulseCustomerId, and existing fieldpulseAssetIds.
 *  - Soft-deleted assets: skip (skipped++).
 */
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerEquipment, customers } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { FieldpulseClient } from "../client";
import type { FieldpulseAsset } from "../types";
import type { PhaseResult } from "./run-import";
import { parseFpDate } from "./jobs";
import { buildFpSpillover } from "./spillover";

export function mapFpAssetType(
  assetType: string | null | undefined,
): "ac" | "furnace" | "heat_pump" | "boiler" | "mini_split" | "thermostat" | "other" {
  const s = (assetType ?? "").toLowerCase();
  // Check more-specific / longer terms before shorter ones to avoid false matches
  // (e.g. "furnace" contains "ac", "heat pump" must come before "heat").
  if (s.includes("heat pump")) return "heat_pump";
  if (s.includes("furnace") || s.includes("heating unit")) return "furnace";
  if (s.includes("air condition") || s.includes("cooling") || /\bac\b/.test(s)) return "ac";
  if (s.includes("boiler")) return "boiler";
  if (s.includes("mini") || s.includes("split")) return "mini_split";
  if (s.includes("thermostat")) return "thermostat";
  return "other";
}

export async function importAssetsFromFieldpulse(
  orgId: string,
  counts: PhaseResult,
  client: FieldpulseClient,
): Promise<void> {
  const { items, totalCount, cappedByMaxPages } = await client.listAssets();
  counts.fetched = items.length;
  counts.total = totalCount ?? null;

  if (cappedByMaxPages) {
    logger.warn(
      {
        orgId,
        fetched: items.length,
        note: "Walk exhausted maxPages on a full page — possible truncation; raise maxPages or investigate",
      },
      "FP assets import: walk may be incomplete (cappedByMaxPages=true)",
    );
    (counts as unknown as Record<string, unknown>).cappedNote = "cappedByMaxPages";
  }

  // Pre-select existing fieldpulseAssetIds for this org.
  const existingRows = await db
    .select({ fieldpulseAssetId: customerEquipment.fieldpulseAssetId })
    .from(customerEquipment)
    .where(
      and(
        eq(customerEquipment.organizationId, orgId),
        isNotNull(customerEquipment.fieldpulseAssetId),
      ),
    );
  const existingFpIds = new Set(existingRows.map((r) => r.fieldpulseAssetId as string));

  // Pre-select customers by fieldpulseCustomerId → native id.
  const customerRows = await db
    .select({ fpId: customers.fieldpulseCustomerId, nativeId: customers.id })
    .from(customers)
    .where(and(eq(customers.organizationId, orgId), isNotNull(customers.fieldpulseCustomerId)));
  const customerMap = new Map(customerRows.map((r) => [r.fpId as string, r.nativeId]));

  for (const asset of items) {
    if (asset.deletedAt != null) {
      counts.skipped++;
      continue;
    }

    // customerId is REQUIRED by the customer_equipment schema.
    if (!asset.customerId) {
      counts.skipped++;
      logger.debug({ orgId, fpAssetId: asset.id }, "FP asset import: no customer_id — skipping");
      continue;
    }
    const resolvedCustomerId = customerMap.get(asset.customerId) ?? null;
    if (!resolvedCustomerId) {
      counts.skipped++;
      logger.debug(
        { orgId, fpAssetId: asset.id, fpCustomerId: asset.customerId },
        "FP asset import: FP customer_id not found in native customers — skipping",
      );
      continue;
    }

    try {
      const isNew = !existingFpIds.has(asset.id);
      const mappedType = mapFpAssetType(asset.assetType);
      const parsedInstallDate = parseFpDate(asset.installDate);
      // Spillover: build from the raw FP asset payload (snake_case fields).
      // asset._raw is threaded through toAsset(); the denylist model captures
      // any unpromoted, non-denied primitive long-tail fields FP may carry.
      const fpSpillover = buildFpSpillover(asset._raw ?? {}, "assets");

      await db
        .insert(customerEquipment)
        .values({
          organizationId: orgId,
          customerId: resolvedCustomerId,
          fieldpulseAssetId: asset.id,
          equipmentType: mappedType,
          serialNumber: asset.tag ?? null,
          installDate: parsedInstallDate,
          notes: asset.title ?? null,
          locationInHome: asset.locationDescription ?? null,
          fieldpulseData: fpSpillover,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [customerEquipment.organizationId, customerEquipment.fieldpulseAssetId],
          targetWhere: sql`${customerEquipment.fieldpulseAssetId} IS NOT NULL`,
          set: {
            equipmentType: mappedType,
            serialNumber: asset.tag ?? null,
            installDate: parsedInstallDate,
            notes: asset.title ?? null,
            locationInHome: asset.locationDescription ?? null,
            fieldpulseData: fpSpillover,
            updatedAt: new Date(),
          },
        });

      if (isNew) {
        existingFpIds.add(asset.id);
        counts.created++;
      } else {
        counts.updated++;
      }
    } catch (err) {
      counts.errors++;
      logger.error(
        {
          orgId,
          fpAssetId: asset.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "FP asset import: per-record error (continuing)",
      );
    }
  }

  if (counts.errors > 0) {
    logger.warn(
      { orgId, errors: counts.errors, fetched: counts.fetched },
      "FP asset import: completed with per-record errors — check logs above for details",
    );
  }
}

export type { FieldpulseAsset };
