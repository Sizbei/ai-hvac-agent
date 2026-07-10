/**
 * FieldPulse pricebook items inbound pull.
 *
 * importItemsFromFieldpulse pages the full /items list (~17,536 rows over
 * 877 pages at 20/page) and upserts each active record into the native
 * pricebook_items table, linked by fieldpulseItemId.
 *
 * Key decisions:
 *  - totalCount is NULL on /items (same as /invoices — FP does not return it).
 *    counts.total is set to null so the run ledger reflects "indeterminate".
 *  - Type mapping: FP's `type` field vocabulary is unconfirmed. Best-effort
 *    map onto ("service" | "material" | "equipment"); unknown values default to
 *    "service" (most generic) and are tallied + logged once at end.
 *  - priceCents: parsed from `default_unit_price` (dollar string or number)
 *    via dollarsToCents; absent/null → 0.
 *  - Nameless items (blank name after trim) are skipped (skipped++).
 *  - Inactive items (is_active === false) are upserted with active=false so
 *    the catalog accurately reflects FP's state.
 *  - Pre-select Set on fieldpulseItemId for exact created/updated split.
 *  - Per-record containment: errors++ and continue, never abort.
 *  - Upsert keyed on (org, fieldpulseItemId) with the partial-index predicate
 *    on the conflict target (WHERE fieldpulse_item_id IS NOT NULL).
 *  - cappedByMaxPages: if the walk was capped by maxPages, logs a WARN and
 *    sets counts.cappedNote so operators can see it in the run ledger.
 */
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pricebookItems } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import {
  FP_ITEM_SERVICE_TYPES,
  FP_ITEM_MATERIAL_TYPES,
  FP_ITEM_EQUIPMENT_TYPES,
} from "../client";
import type { FieldpulseClient } from "../client";
import type { FieldpulseItem } from "../types";
import type { PhaseResult } from "./run-import";
import { buildFpSpillover } from "./spillover";

/**
 * Returns true when the rawFpType from FP was not in any known explicit set.
 * These are the rows for which "service" is a fallback, not an explicit match.
 * Delegates to the canonical sets exported from client.ts to stay in sync.
 */
function isUnknownFpType(rawFpType: string | null): boolean {
  if (!rawFpType) return true;
  const s = rawFpType.toLowerCase().trim();
  return (
    !FP_ITEM_SERVICE_TYPES.has(s) &&
    !FP_ITEM_MATERIAL_TYPES.has(s) &&
    !FP_ITEM_EQUIPMENT_TYPES.has(s)
  );
}

// ── Importer ─────────────────────────────────────────────────────────────────

export async function importItemsFromFieldpulse(
  orgId: string,
  counts: PhaseResult,
  client: FieldpulseClient,
): Promise<void> {
  const { items, totalCount, cappedByMaxPages } = await client.listItems();
  counts.fetched = items.length;
  counts.total = totalCount ?? null; // always null per FP /items endpoint

  if (cappedByMaxPages) {
    logger.warn(
      {
        orgId,
        fetched: items.length,
        note: "Walk exhausted maxPages on a full page — possible truncation; raise maxPages or investigate",
      },
      "FP items import: walk may be incomplete (cappedByMaxPages=true)",
    );
    // Surface the cap in the run ledger (counts is serialized to fp_import_runs).
    (counts as unknown as Record<string, unknown>).cappedNote = "cappedByMaxPages";
  }

  // Pre-select existing fieldpulseItemIds for this org for exact created/updated split.
  const existingRows = await db
    .select({ fieldpulseItemId: pricebookItems.fieldpulseItemId })
    .from(pricebookItems)
    .where(
      and(
        eq(pricebookItems.organizationId, orgId),
        isNotNull(pricebookItems.fieldpulseItemId),
      ),
    );
  const existingFpIds = new Set(
    existingRows.map((r) => r.fieldpulseItemId as string),
  );

  // Tally unknown FP type strings for end-of-run warning (honesty over silence).
  const unknownTypes = new Map<string, number>();

  for (const fp of items) {
    try {
      const name = fp.name.trim();
      if (!name) {
        counts.skipped++;
        continue;
      }

      // Track type unknowns before the upsert.
      if (isUnknownFpType(fp.rawFpType)) {
        const key = fp.rawFpType ?? "(null)";
        unknownTypes.set(key, (unknownTypes.get(key) ?? 0) + 1);
      }

      const isNew = !existingFpIds.has(fp.id);

      // Build spillover from the raw FP item payload (snake_case fields).
      // fp._raw is threaded through toItem(); the denylist model captures any
      // unpromoted, non-denied primitive long-tail fields FP may carry.
      const fpSpillover = buildFpSpillover(fp._raw ?? {}, "items");

      await db
        .insert(pricebookItems)
        .values({
          organizationId: orgId,
          fieldpulseItemId: fp.id,
          type: fp.type,
          name,
          // description and costCents are existing columns — map from FP now.
          description: fp.description ?? null,
          priceCents: fp.priceCents,
          costCents: fp.costCents ?? 0,
          // markupPct: FP-owned on synced rows. Use mapped value when present.
          markupPct: fp.markupPct ?? 0,
          active: fp.isActive,
          // P1 new columns.
          isLaborItem: fp.isLaborItem,
          quantityAvailable: fp.quantityAvailable ?? null,
          vendorType: fp.vendorType ?? null,
          fieldpulseData: fpSpillover,
        })
        .onConflictDoUpdate({
          // FP-owned fields on mirrored rows: cost/markup/description are overwritten
          // nightly (FP is the source of truth for synced items). Native items with
          // fieldpulse_item_id NULL are never touched by this conflict target.
          target: [pricebookItems.organizationId, pricebookItems.fieldpulseItemId],
          targetWhere: sql`${pricebookItems.fieldpulseItemId} IS NOT NULL`,
          set: {
            name,
            type: fp.type,
            description: fp.description ?? null,
            priceCents: fp.priceCents,
            costCents: fp.costCents ?? 0,
            markupPct: fp.markupPct ?? 0,
            active: fp.isActive,
            isLaborItem: fp.isLaborItem,
            quantityAvailable: fp.quantityAvailable ?? null,
            vendorType: fp.vendorType ?? null,
            fieldpulseData: fpSpillover,
            updatedAt: new Date(),
          },
        });

      if (isNew) {
        existingFpIds.add(fp.id);
        counts.created++;
      } else {
        counts.updated++;
      }
    } catch (err) {
      counts.errors++;
      logger.error(
        {
          orgId,
          fpItemId: fp.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "FP items import: per-record error (continuing)",
      );
    }
  }

  if (unknownTypes.size > 0) {
    logger.warn(
      { orgId, unknownTypes: Object.fromEntries(unknownTypes) },
      "FP items import: unknown FP type values encountered — mapped to 'service'",
    );
  }

  if (counts.errors > 0) {
    logger.warn(
      { orgId, errors: counts.errors, fetched: counts.fetched },
      "FP items import: completed with per-record errors — check logs above",
    );
  }
}

export type { FieldpulseItem };
