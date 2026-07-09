/**
 * Phase 5 — FieldPulse invoices full-history backfill.
 *
 * importInvoicesFromFieldpulse pages the full /invoices list and feeds each
 * already-fetched row into upsertInvoiceRecord — avoiding the N wasteful
 * per-invoice re-fetches that pullInvoiceFromFieldpulse adds.
 *
 * Key decisions:
 *  - totalCount is NULL on /invoices (Phase 0.5 verified); counts.total is set
 *    to null so the run ledger reflects "indeterminate" and the dry-run
 *    completeness assert is skipped for this phase.
 *  - created/updated split is exact: a pre-selected Set of existing
 *    fieldpulseInvoiceIds for the org is built before the walk; each invoice is
 *    classified before upsertInvoiceRecord is called.
 *  - Soft-deleted invoices (deletedAt non-null) are counted as skipped and
 *    never written — mirroring the Phase 0.5 job shape discovery.
 *  - Per-record errors are contained: errors++ and continue, never abort.
 *    A once-per-run summary warns when any errors occurred.
 */
import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { invoices } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { upsertInvoiceRecord } from "../invoice-sync";
import type { FieldpulseClient } from "../client";
import type { FieldpulseInvoice } from "../types";
import type { PhaseResult } from "./run-import";

export async function importInvoicesFromFieldpulse(
  orgId: string,
  counts: PhaseResult,
  client: FieldpulseClient,
): Promise<void> {
  // Full invoice walk. totalCount is NULL on /invoices (Phase 0.5) so we size
  // by paging-until-empty; set total = null explicitly (indeterminate).
  const { items, totalCount } = await client.listInvoices();
  counts.fetched = items.length;
  counts.total = totalCount ?? null; // always null per Phase-0.5 verification

  // Pre-select existing fieldpulseInvoiceIds for this org → exact created/updated split.
  const existingRows = await db
    .select({ fieldpulseInvoiceId: invoices.fieldpulseInvoiceId })
    .from(invoices)
    .where(
      and(
        eq(invoices.organizationId, orgId),
        isNotNull(invoices.fieldpulseInvoiceId),
      ),
    );
  const existingFpIds = new Set(existingRows.map((r) => r.fieldpulseInvoiceId as string));

  for (const inv of items) {
    // Skip soft-deleted invoices.
    if (inv.deletedAt != null) {
      counts.skipped++;
      continue;
    }

    try {
      // Classify before upsert so we can count exactly without depending on the
      // outcome string (upsertInvoiceRecord may return "updated" for race winners).
      const isNew = !existingFpIds.has(inv.id);

      const outcome = await upsertInvoiceRecord(orgId, inv);

      if (outcome === "failed") {
        counts.errors++;
        continue;
      }

      // Trust the pre-select classification for created/updated split; treat
      // "skipped" (race/conflict) as updated since the row already exists.
      if (isNew && outcome === "created") {
        existingFpIds.add(inv.id);
        counts.created++;
      } else {
        counts.updated++;
      }
    } catch (err) {
      counts.errors++;
      logger.error(
        {
          orgId,
          fpInvoiceId: inv.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "FP invoice import: per-record error (continuing)",
      );
    }
  }

  if (counts.errors > 0) {
    logger.warn(
      { orgId, errors: counts.errors, fetched: counts.fetched },
      "FP invoice import: completed with per-record errors — check logs above for details",
    );
  }
}

export type { FieldpulseInvoice };
