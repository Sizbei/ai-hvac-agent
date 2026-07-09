/**
 * Phase 10 — FieldPulse comments inbound pull.
 *
 * importCommentsFromFieldpulse pages the full /comments list and creates a
 * customer_notes row for each non-deleted comment whose job has been imported
 * into the native service_requests table.
 *
 * Resolution:
 *  1. Skip comments with deleted_at set (tally skipped).
 *  2. Resolve the FP job id via serviceRequests.fieldpulseJobId → the job's
 *     customerId (so the note lands on the right customer).
 *  3. Skip comments whose job isn't in the native DB (tally unresolvedJob).
 *  4. Insert the note with content prefixed `[FieldPulse job #<fpJobId>] <text>`,
 *     keyed idempotently by (organizationId, fieldpulseCommentId) partial unique.
 *  5. authorId is null (the FP author is not mapped to a native user here;
 *     the schema allows null).
 *
 * Live-verified 2026-07-09: all 11 FP comments have commentable_type = BaseJob.
 * Other types (if any) are silently skipped as unresolved jobs.
 */
import { eq, and, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { customerNotes, serviceRequests } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { FieldpulseClient } from "../client";
import type { FieldpulseComment } from "../types";
import type { PhaseResult } from "./run-import";

// ── Mapper ─────────────────────────────────────────────────────────────────────

export interface MappedFpComment {
  readonly fpCommentId: string;
  readonly fpJobId: string;
  readonly content: string;
}

export type MapCommentResult =
  | { readonly ok: true; readonly comment: MappedFpComment }
  | { readonly ok: false; readonly reason: "deleted" | "no-text" | "no-job-ref" };

/**
 * Pure mapper: FieldpulseComment → MappedFpComment or skip.
 * commentable_type check is intentionally lenient (any type with a commentableId
 * is attempted; the job-resolution step will skip non-job references).
 */
export function mapFpComment(fp: FieldpulseComment): MapCommentResult {
  if (fp.deletedAt != null) {
    return { ok: false, reason: "deleted" };
  }
  const text = fp.text?.trim() || null;
  if (!text) {
    return { ok: false, reason: "no-text" };
  }
  const fpJobId = fp.commentableId?.trim() || null;
  if (!fpJobId) {
    return { ok: false, reason: "no-job-ref" };
  }
  return {
    ok: true,
    comment: {
      fpCommentId: fp.id,
      fpJobId,
      content: `[FieldPulse job #${fpJobId}] ${text}`,
    },
  };
}

// ── Importer ───────────────────────────────────────────────────────────────────

export async function importCommentsFromFieldpulse(
  orgId: string,
  counts: PhaseResult,
  client: FieldpulseClient,
): Promise<void> {
  const { items, totalCount, cappedByMaxPages } = await client.listComments();
  counts.fetched = items.length;
  counts.total = totalCount ?? null;

  if (cappedByMaxPages) {
    logger.warn(
      {
        orgId,
        fetched: items.length,
        note: "Walk exhausted maxPages on a full page — possible truncation; raise maxPages or investigate",
      },
      "FP comments import: walk may be incomplete (cappedByMaxPages=true)",
    );
    (counts as unknown as Record<string, unknown>).cappedNote = "cappedByMaxPages";
  }

  if (totalCount !== null && items.length < totalCount) {
    logger.warn(
      { orgId, fetched: items.length, totalCount, shortfall: totalCount - items.length },
      "FP comment pull: fetched fewer rows than total_count — possible partial walk; check maxPages",
    );
  }

  // Pre-select imported jobs: fpJobId → { customerId } for O(1) resolution.
  const jobRows = await db
    .select({
      fieldpulseJobId: serviceRequests.fieldpulseJobId,
      customerId: serviceRequests.customerId,
    })
    .from(serviceRequests)
    .where(
      and(
        eq(serviceRequests.organizationId, orgId),
        isNotNull(serviceRequests.fieldpulseJobId),
      ),
    );
  const jobByFpId = new Map(
    jobRows.map((r) => [r.fieldpulseJobId as string, r.customerId]),
  );

  let unresolvedJobCount = 0;

  for (const fp of items) {
    const mapped = mapFpComment(fp);
    if (!mapped.ok) {
      counts.skipped++;
      continue;
    }

    const { comment } = mapped;

    try {
      const customerId = jobByFpId.get(comment.fpJobId) ?? null;
      if (!customerId) {
        unresolvedJobCount++;
        counts.skipped++;
        continue;
      }

      // Idempotent insert keyed on (organizationId, fieldpulseCommentId).
      const [inserted] = await db
        .insert(customerNotes)
        .values({
          organizationId: orgId,
          customerId,
          authorId: null,
          content: comment.content,
          noteType: "general",
          fieldpulseCommentId: comment.fpCommentId,
        })
        .onConflictDoNothing({
          target: [customerNotes.organizationId, customerNotes.fieldpulseCommentId],
          where: isNotNull(customerNotes.fieldpulseCommentId),
        })
        .returning({ id: customerNotes.id });

      if (inserted) {
        counts.created++;
      } else {
        // Re-run: comment already imported.
        counts.skipped++;
      }
    } catch (err) {
      counts.errors++;
      logger.error(
        {
          orgId,
          fpCommentId: comment.fpCommentId,
          error: err instanceof Error ? err.message : String(err),
        },
        "FP comment import: per-record error (continuing)",
      );
    }
  }

  if (unresolvedJobCount > 0) {
    logger.warn(
      { orgId, unresolvedJobCount },
      "FP comment import: skipped comments whose FP job isn't imported — run jobs phase first",
    );
  }
}
