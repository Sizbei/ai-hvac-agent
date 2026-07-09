/**
 * Phase 5 — FieldPulse per-job metrics enrichment.
 *
 * For each service_request with a fieldpulseJobId (org-scoped), calls
 * GET /jobs/{id} and extracts the fieldpulse_metrics shape:
 *   { statusLogSeconds: { pending, on_the_way, in_progress, completed },
 *     totalPriceCents, mapCoords }
 *
 * Idempotent: pure overwrite of fieldpulse_metrics on every run.
 * Live account 182499 has 53 jobs → 53 per-id calls, which is acceptable.
 *
 * Called by the "job-metrics" phase in run-import.ts.
 */
import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { FieldpulseClient } from "../client";
import type { PhaseResult } from "./run-import";

// ── Metrics extraction ────────────────────────────────────────────────────────

/**
 * The shape stored in fieldpulse_metrics. All fields nullable — the FP API
 * may not return them for every job.
 */
export interface FpJobMetrics {
  readonly statusLogSeconds: {
    readonly pending: number | null;
    readonly on_the_way: number | null;
    readonly in_progress: number | null;
    readonly completed: number | null;
  };
  readonly totalPriceCents: number | null;
  readonly mapCoords: unknown | null;
}

/**
 * Extract FpJobMetrics from a raw GET /jobs/{id} response.
 * Defensively handles string/number coercion and missing keys.
 * Returns null only if the raw input is entirely unusable.
 */
export function extractJobMetrics(raw: unknown): FpJobMetrics | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  // status_log: object of stage → seconds. Values may be strings or numbers.
  const statusLog = obj.status_log;
  const toSeconds = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
    if (typeof v === "string") {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    return null;
  };
  const statusLogSeconds = {
    pending: toSeconds(
      statusLog != null && typeof statusLog === "object"
        ? (statusLog as Record<string, unknown>).pending
        : undefined,
    ),
    on_the_way: toSeconds(
      statusLog != null && typeof statusLog === "object"
        ? (statusLog as Record<string, unknown>).on_the_way
        : undefined,
    ),
    in_progress: toSeconds(
      statusLog != null && typeof statusLog === "object"
        ? (statusLog as Record<string, unknown>).in_progress
        : undefined,
    ),
    completed: toSeconds(
      statusLog != null && typeof statusLog === "object"
        ? (statusLog as Record<string, unknown>).completed
        : undefined,
    ),
  };

  // total_price: dollar-string (e.g. "245.00") or number → cents.
  let totalPriceCents: number | null = null;
  const rawPrice = obj.total_price;
  if (typeof rawPrice === "number" && Number.isFinite(rawPrice)) {
    totalPriceCents = Math.round(rawPrice * 100);
  } else if (typeof rawPrice === "string" && rawPrice.trim() !== "") {
    const n = parseFloat(rawPrice);
    if (Number.isFinite(n)) totalPriceCents = Math.round(n * 100);
  }

  // map: pass through as-is (coordinates object or null).
  const mapCoords = obj.map ?? null;

  return { statusLogSeconds, totalPriceCents, mapCoords };
}

// ── Enrichment pass ───────────────────────────────────────────────────────────

export async function enrichJobMetrics(
  orgId: string,
  counts: PhaseResult,
  client: FieldpulseClient,
): Promise<void> {
  // Fetch all service_requests with a fieldpulseJobId for this org.
  const rows = await db
    .select({
      id: serviceRequests.id,
      fieldpulseJobId: serviceRequests.fieldpulseJobId,
    })
    .from(serviceRequests)
    .where(
      and(
        eq(serviceRequests.organizationId, orgId),
        isNotNull(serviceRequests.fieldpulseJobId),
      ),
    );

  counts.fetched = rows.length;

  for (const row of rows) {
    const fpId = row.fieldpulseJobId as string;
    try {
      // getJobRaw returns the unwrapped API payload without running it through
      // toJob's field whitelist, which drops status_log, total_price, and map —
      // exactly the fields extractJobMetrics needs.
      const raw = await client.getJobRaw(fpId);
      const metrics = extractJobMetrics(raw);
      if (metrics === null) {
        counts.skipped++;
        continue;
      }
      await db
        .update(serviceRequests)
        .set({
          fieldpulseMetrics: metrics as typeof serviceRequests.$inferInsert["fieldpulseMetrics"],
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(serviceRequests.organizationId, orgId),
            eq(serviceRequests.id, row.id),
          ),
        );
      counts.updated++;
    } catch (err) {
      counts.errors++;
      logger.error(
        {
          orgId,
          fpJobId: fpId,
          requestId: row.id,
          error: err instanceof Error ? err.message : String(err),
        },
        "FP job-metrics: per-job error (continuing)",
      );
    }
  }
}
