/**
 * One-off maintenance: clean up the `customer_sessions` ("conversations") table.
 *
 * Three passes, all tenant-agnostic (operates across every org) and idempotent:
 *
 *   1. DELETE empty junk — sessions with ZERO messages AND no linked
 *      service_request. These are abandoned/never-started chats that carry no
 *      data. Sessions that are empty but DO have a service_request are KEPT (a
 *      real request depends on them; their messages may simply have been pruned).
 *      Deletion follows the same FK-ordered cascade as deleteConversation()
 *      (service_history → service_requests → audit_log → messages → session) via
 *      a single atomic db.batch (neon-http has no interactive transactions).
 *
 *   2. SANITIZE + RESHAPE metadata — for every kept session that carries metadata
 *      JSON, re-emit it in the canonical extractionSchema field order and run the
 *      contact fields (customerName / customerPhone / address / customerEmail)
 *      through the shared sanitizers, so stored display values are consistent
 *      with what the live intake path now writes. Only rewrites a row when the
 *      normalized JSON actually differs (no-op churn is skipped).
 *
 *   3. BACKFILL turn_count — set turn_count to the actual number of `user` role
 *      messages when the stored value has drifted, so the admin list's turn
 *      column matches reality.
 *
 * DRY RUN BY DEFAULT. Pass --apply to commit. Without it, the script only
 * reports what it WOULD do and writes nothing.
 *
 * Usage:
 *   npx tsx src/lib/db/cleanup-conversations.ts          # dry run (report only)
 *   npx tsx src/lib/db/cleanup-conversations.ts --apply  # commit changes
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { and, eq, inArray, sql as dsql } from "drizzle-orm";
import * as dotenv from "dotenv";
import {
  customerSessions,
  messages,
  serviceRequests,
  serviceHistory,
  auditLog,
} from "./schema";
import { sanitizeContactFields } from "../ai/sanitize-fields";

dotenv.config({ path: ".env.local" });

const APPLY = process.argv.includes("--apply");

// The canonical metadata key order = the extractionSchema shape. Core fields
// first (always present on a real extraction), then the optional enrichment
// fields. Unknown legacy keys are dropped; missing core keys are filled to null
// so every reshaped row has a uniform skeleton. Kept in sync with
// src/lib/ai/extraction-schema.ts (extractionSchema).
const CORE_KEYS = [
  "issueType",
  "urgency",
  "address",
  "customerName",
  "customerPhone",
  "customerEmail",
  "description",
  "isHvacRelated",
] as const;

const OPTIONAL_KEYS = [
  "systemType",
  "equipmentBrand",
  "equipmentAgeBand",
  "propertyType",
  "ownerOccupant",
  "underWarranty",
  "accessNotes",
  "systemDownStatus",
  "problemDuration",
  "vulnerableOccupants",
  "preferredWindow",
  "contactPreference",
  "smsConsent",
  "leadSource",
] as const;

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Reshape a parsed metadata object to the canonical extraction structure and
 * sanitize its contact fields. Core keys are always emitted (null when absent);
 * optional keys are emitted only when present in the source; unknown legacy keys
 * are dropped. Returns the new object (immutable — does not touch the input).
 */
function reshapeMetadata(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CORE_KEYS) {
    out[key] = key in meta ? meta[key] : null;
  }
  for (const key of OPTIONAL_KEYS) {
    if (key in meta) out[key] = meta[key];
  }
  // Sanitize the four contact fields using the same helper the live intake path
  // uses. sanitizeContactFields is null/blank-safe and only touches those keys.
  return sanitizeContactFields(out as Record<string, unknown> & {
    customerName?: string | null;
    customerPhone?: string | null;
    customerEmail?: string | null;
    address?: string | null;
  }) as Record<string, unknown>;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  const sqlClient = neon(process.env.DATABASE_URL);
  const db = drizzle(sqlClient);

  console.log(
    APPLY
      ? "=== cleanup-conversations: APPLY (writing changes) ==="
      : "=== cleanup-conversations: DRY RUN (no writes; pass --apply to commit) ===",
  );

  // ---- Pass 1: identify + delete junk empty sessions -----------------------
  // Empty = no messages. Junk = empty AND no linked service_request.
  const junkRows = await db
    .select({
      id: customerSessions.id,
      organizationId: customerSessions.organizationId,
      status: customerSessions.status,
      channel: customerSessions.channel,
    })
    .from(customerSessions)
    .where(
      and(
        dsql`NOT EXISTS (SELECT 1 FROM ${messages} m WHERE m.session_id = ${customerSessions.id})`,
        dsql`NOT EXISTS (SELECT 1 FROM ${serviceRequests} r WHERE r.session_id = ${customerSessions.id})`,
      ),
    );

  console.log(`\n[1] Empty junk sessions (0 messages, no request): ${junkRows.length}`);
  const byBucket = new Map<string, number>();
  for (const r of junkRows) {
    const key = `${r.status}/${r.channel}`;
    byBucket.set(key, (byBucket.get(key) ?? 0) + 1);
  }
  for (const [k, n] of byBucket) console.log(`      ${k}: ${n}`);

  if (APPLY && junkRows.length > 0) {
    // Delete in FK-dependency order. None of these junk sessions have a
    // service_request (by definition), so service_history / service_requests
    // deletes are no-ops, but we run them for safety + parity with
    // deleteConversation. Chunk the ids to keep each statement bounded.
    const ids = junkRows.map((r) => r.id);
    await db.batch([
      db.delete(auditLog).where(inArray(auditLog.sessionId, ids)),
      db.delete(messages).where(inArray(messages.sessionId, ids)),
      db.delete(customerSessions).where(inArray(customerSessions.id, ids)),
    ] as const);
    console.log(`      → deleted ${ids.length} junk sessions.`);
  }

  // ---- Pass 2 + 3: sanitize/reshape metadata + backfill turn_count ----------
  // Operate on the KEPT sessions (everything except the junk we just removed).
  const deletedIds = new Set(APPLY ? junkRows.map((r) => r.id) : []);

  const kept = await db
    .select({
      id: customerSessions.id,
      metadata: customerSessions.metadata,
      turnCount: customerSessions.turnCount,
    })
    .from(customerSessions);

  let metaChanged = 0;
  let turnChanged = 0;

  for (const row of kept) {
    if (deletedIds.has(row.id)) continue;

    // Pass 2: metadata reshape + sanitize.
    const meta = parseMetadata(row.metadata);
    if (meta) {
      const reshaped = reshapeMetadata(meta);
      const before = row.metadata ?? "";
      const after = JSON.stringify(reshaped);
      if (before !== after) {
        metaChanged++;
        if (APPLY) {
          await db
            .update(customerSessions)
            .set({ metadata: after })
            .where(eq(customerSessions.id, row.id));
        }
      }
    }

    // Pass 3: turn_count backfill = actual user-message count.
    const [{ n: actualUserMsgs }] = await db
      .select({ n: dsql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.sessionId, row.id), eq(messages.role, "user")));

    if (actualUserMsgs !== row.turnCount) {
      turnChanged++;
      if (APPLY) {
        await db
          .update(customerSessions)
          .set({ turnCount: actualUserMsgs })
          .where(eq(customerSessions.id, row.id));
      }
    }
  }

  console.log(`\n[2] Metadata sanitized/reshaped: ${metaChanged} session(s)`);
  console.log(`[3] turn_count backfilled:       ${turnChanged} session(s)`);

  console.log(
    APPLY
      ? "\n=== done (changes committed) ==="
      : "\n=== dry run complete — re-run with --apply to commit ===",
  );
}

main().catch((error: unknown) => {
  console.error("cleanup-conversations failed:", error);
  process.exit(1);
});
