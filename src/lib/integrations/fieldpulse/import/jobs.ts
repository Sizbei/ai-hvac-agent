/**
 * Phase 4 — FieldPulse jobs inbound pull.
 *
 * importJobsFromFieldpulse pages the full /jobs list and upserts each active
 * record into the native service_requests table, linking by fieldpulseJobId.
 *
 * Status mapping rule (pluggable — edit FP_JOB_STATUS_MAP when the user names
 * their workflow):
 *   1. completedAt non-null  → "completed" (corroborated by live data).
 *   2. FP_JOB_STATUS_MAP lookup by statusInt (one-line-editable per-int).
 *   3. Fallback: "pending" + tally the unknown int (logged once at walk end).
 *
 * Technician resolution — "founder self-heal":
 *   On a miss against the cached native fieldpulseUserId set, the importer
 *   consults a ONCE-per-run cached listUsers() result. When the FP user is
 *   found, it upserts them as a technician (using technician-sync's shape)
 *   and assigns the resolved id. This handles the founder (role 1 = admin, but
 *   holds job assignments in prod) without fabricating a generic placeholder.
 *
 * service_requests.sessionId is NOT NULL, so each inserted job gets a synthetic
 * "submitted" session (channel=web, token=fp-import-<fpId>), mirroring the
 * pattern in membership-visit-queries.ts.
 *
 * PII / encryption convention mirrored from submit-session-request.ts:
 *   - customerNameEncrypted / customerPhoneEncrypted / customerEmailEncrypted /
 *     addressEncrypted: encrypted via encrypt(). For FP-imported jobs these are
 *     set to null (contact PII lives on the customer row, not duplicated here).
 *   - issueType and description: plaintext (operational, non-identifying).
 *   - FP job notes + field_notes → description (plaintext, operator-facing).
 */
import { eq, and, isNotNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { serviceRequests, customers, users, customerSessions } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import type { FieldpulseClient } from "../client";
import type { FieldpulseJob, FieldpulseUser } from "../types";
import type { PhaseResult } from "./run-import";
import type { RequestStatus } from "@/lib/admin/request-status";
import { generateReferenceNumber } from "@/lib/requests/submit-session-request";

// ── Status map (pluggable) ─────────────────────────────────────────────────────
// Edit this one object to expand the vocabulary when the user names their workflow.
// Key = FP integer status stringified; value = native RequestStatus.
// ONLY confirmed meanings belong here — live account 182499 shows:
//   "4" (×9, ALL have completedAt) → completed.
// "1","2","3","6" are unmapped and fall back to "pending" + tally until named.
const FP_JOB_STATUS_MAP: Record<string, RequestStatus> = { "4": "completed" };

// ── Date parser ────────────────────────────────────────────────────────────────

/**
 * Parse a FieldPulse timestamp to a Date (UTC).
 * Accepts both the FP list format ("YYYY-MM-DD HH:MM:SS") and the ISO 8601
 * format used in some fields ("YYYY-MM-DDTHH:MM:SS.000000Z").
 * Returns null on any malformed input so callers degrade gracefully.
 *
 * The bare format carries no timezone; we treat it as UTC — LIVE-VERIFIED
 * (2026-07-09, account 182499): schedule hours span 12-23 UTC with zero
 * morning values, which as Eastern wall-times would mean a shop that never
 * works mornings; as UTC they map to 8am-7pm Eastern — a normal service day.
 */
export function parseFpDate(raw: string | null | undefined): Date | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // If it already has a timezone designator (Z or +/-offset), parse as-is.
  const hasTimezone = /[Zz]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed);
  const iso = hasTimezone ? trimmed : trimmed.replace(" ", "T") + "Z";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

// ── Mapper ─────────────────────────────────────────────────────────────────────

export interface MappedFpJob {
  readonly fpId: string;
  readonly fpCustomerId: string;
  readonly status: RequestStatus;
  readonly issueType: string;
  readonly description: string;
  readonly scheduleStart: Date | null;
  readonly scheduleEnd: Date | null;
  readonly arrivalWindowStart: Date | null;
  readonly arrivalWindowEnd: Date | null;
  readonly completedAt: Date | null;
  readonly scheduledDate: Date | null;
  /** First assignment's user_id (primary assignee). */
  readonly assignedFpUserId: string | null;
  /** Additional assignment user_ids beyond the first (for description annotation). */
  readonly additionalFpUserIds: readonly string[];
}

export type MapJobResult =
  | { readonly ok: true; readonly job: MappedFpJob }
  | { readonly ok: false; readonly reason: "deleted" };

/** Accumulates unknown status int tallies during a walk; logged once at end. */
export type UnknownStatusTally = Map<string, number>;

/**
 * Pure mapper: FieldpulseJob (with Phase-4 extended fields) → MappedFpJob or skip.
 * `unknownTally` is mutated in-place so callers log a single summary.
 */
export function mapFpJob(
  fp: FieldpulseJob,
  unknownTally: UnknownStatusTally,
): MapJobResult {
  if (fp.deletedAt != null) {
    return { ok: false, reason: "deleted" };
  }

  // Status mapping.
  const completedAt = parseFpDate(fp.completedAt);
  let status: RequestStatus;
  if (completedAt != null) {
    status = "completed";
  } else {
    const statusKey = fp.statusInt != null ? String(fp.statusInt) : fp.workStatus ?? null;
    const mapped = statusKey ? FP_JOB_STATUS_MAP[statusKey] : undefined;
    if (mapped) {
      status = mapped;
    } else {
      status = "pending";
      if (statusKey) {
        unknownTally.set(statusKey, (unknownTally.get(statusKey) ?? 0) + 1);
      }
    }
  }

  // Title: jobType → subtitle → fallback.
  const jobType = fp.jobType?.trim() || null;
  const subtitle = fp.subtitle?.trim() || null;
  const issueType = jobType ?? subtitle ?? "FieldPulse job";

  // Description: non-empty subtitle + notes + fieldNotes, pipe-delimited.
  const notes = fp.notes?.trim() || null;
  const fieldNotes = fp.fieldNotes?.trim() || null;
  const descParts: string[] = [];
  if (subtitle && subtitle !== issueType) descParts.push(subtitle);
  if (notes) descParts.push(notes);
  if (fieldNotes) descParts.push(fieldNotes);
  const description = descParts.join(" | ") || issueType;

  // Schedule fields.
  const scheduleStart = parseFpDate(fp.scheduleStart);
  const scheduleEnd = parseFpDate(fp.scheduleEnd);
  const scheduledDate = scheduleStart;

  // Arrival window (customer-facing); fall back to schedule start/end.
  const arrivalWindowStart = parseFpDate(fp.arrivalWindowStart) ?? scheduleStart;
  const arrivalWindowEnd = parseFpDate(fp.arrivalWindowEnd) ?? scheduleEnd;

  // First assignment's user id (primary assignee); additional ones are tallied.
  const assignedFpUserId = fp.assignments?.[0]?.userId ?? null;
  const additionalFpUserIds =
    fp.assignments && fp.assignments.length > 1
      ? fp.assignments.slice(1).map((a) => a.userId)
      : [];

  return {
    ok: true,
    job: {
      fpId: fp.id,
      fpCustomerId: fp.customerId,
      status,
      issueType,
      description,
      scheduleStart,
      scheduleEnd,
      arrivalWindowStart,
      arrivalWindowEnd,
      completedAt,
      scheduledDate,
      assignedFpUserId,
      additionalFpUserIds,
    },
  };
}

// ── Technician self-heal ───────────────────────────────────────────────────────

/**
 * Upsert a technician from a FieldPulse user (founder self-heal).
 * Mirrors technician-sync.ts's upsert shape: same columns, same conflict target
 * (org + email), same setWhere guard (only overwrites an existing technician row).
 */
async function upsertTechnicianFromFpUser(
  orgId: string,
  fpUser: FieldpulseUser,
): Promise<string | null> {
  const email =
    typeof fpUser.email === "string" && fpUser.email.trim()
      ? fpUser.email.trim().toLowerCase()
      : null;
  const name =
    typeof fpUser.name === "string" && fpUser.name.trim()
      ? fpUser.name.trim()
      : null;
  if (!email || !name) {
    logger.warn(
      { fpUserId: fpUser.id },
      "FP job import self-heal: skipping FP user with no email or name",
    );
    return null;
  }
  const [row] = await db
    .insert(users)
    .values({
      organizationId: orgId,
      email,
      name,
      role: "technician",
      isActive: fpUser.isActive !== false,
      passwordHash: null,
      fieldpulseUserId: fpUser.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [users.organizationId, users.email],
      set: {
        name,
        isActive: fpUser.isActive !== false,
        fieldpulseUserId: fpUser.id,
        updatedAt: new Date(),
      },
      setWhere: eq(users.role, "technician"),
    })
    .returning({ id: users.id });
  return row?.id ?? null;
}

// ── Importer ───────────────────────────────────────────────────────────────────

export async function importJobsFromFieldpulse(
  orgId: string,
  counts: PhaseResult,
  client: FieldpulseClient,
): Promise<void> {
  // Full job list walk.
  const { items, totalCount } = await client.listJobs();
  counts.fetched = items.length;
  counts.total = totalCount ?? null;

  if (totalCount !== null && items.length < totalCount) {
    logger.warn(
      { orgId, fetched: items.length, totalCount, shortfall: totalCount - items.length },
      "FP job pull: fetched fewer rows than total_count — possible partial walk; check maxPages",
    );
  }

  // Pre-select existing fieldpulseJobIds for this org → exact created/updated split.
  const existingRows = await db
    .select({ fieldpulseJobId: serviceRequests.fieldpulseJobId })
    .from(serviceRequests)
    .where(
      and(
        eq(serviceRequests.organizationId, orgId),
        isNotNull(serviceRequests.fieldpulseJobId),
      ),
    );
  const existingFpIds = new Set(existingRows.map((r) => r.fieldpulseJobId as string));

  // Pre-select native customer ids keyed by fieldpulseCustomerId for O(1) lookup.
  const customerRows = await db
    .select({ id: customers.id, fieldpulseCustomerId: customers.fieldpulseCustomerId })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, orgId),
        isNotNull(customers.fieldpulseCustomerId),
      ),
    );
  const customerByFpId = new Map(
    customerRows.map((r) => [r.fieldpulseCustomerId as string, r.id]),
  );

  // Pre-select native user ids keyed by fieldpulseUserId.
  const techRows = await db
    .select({ id: users.id, fieldpulseUserId: users.fieldpulseUserId })
    .from(users)
    .where(
      and(
        eq(users.organizationId, orgId),
        isNotNull(users.fieldpulseUserId),
      ),
    );
  const techByFpId = new Map(
    techRows.map((r) => [r.fieldpulseUserId as string, r.id]),
  );

  // Founder self-heal: lazy-loaded FP user cache (one listUsers() call per run).
  let fpUserCache: Map<string, FieldpulseUser> | null = null;
  async function resolveFpUserCache(): Promise<Map<string, FieldpulseUser>> {
    if (fpUserCache !== null) return fpUserCache;
    const fpUsers = await client.listUsers();
    fpUserCache = new Map(fpUsers.map((u) => [u.id, u]));
    return fpUserCache;
  }

  const unknownTally: UnknownStatusTally = new Map();
  let missingCustomerCount = 0;

  for (const fp of items) {
    let mapped: MapJobResult;
    try {
      mapped = mapFpJob(fp, unknownTally);
    } catch (err) {
      counts.errors++;
      logger.error(
        { orgId, fpId: fp.id, error: err instanceof Error ? err.message : String(err) },
        "FP job import: mapper error (continuing)",
      );
      continue;
    }

    if (!mapped.ok) {
      counts.skipped++;
      continue;
    }

    const { job } = mapped;

    try {
      // Resolve customer by fieldpulseCustomerId (Phase 3 guarantees it).
      const customerId = customerByFpId.get(job.fpCustomerId) ?? null;
      if (!customerId) {
        missingCustomerCount++;
        counts.skipped++;
        continue;
      }

      // Resolve technician by fieldpulseUserId.
      let assignedTo: string | null = null;
      if (job.assignedFpUserId) {
        const cached = techByFpId.get(job.assignedFpUserId) ?? null;
        if (cached) {
          assignedTo = cached;
        } else {
          // Founder self-heal: consult the FP roster.
          const fpRoster = await resolveFpUserCache();
          const fpUser = fpRoster.get(job.assignedFpUserId) ?? null;
          if (fpUser) {
            const healedId = await upsertTechnicianFromFpUser(orgId, fpUser);
            if (healedId) {
              techByFpId.set(job.assignedFpUserId, healedId);
              assignedTo = healedId;
              logger.info(
                { orgId, fpUserId: job.assignedFpUserId, nativeId: healedId },
                "FP job import: self-healed technician from FP roster",
              );
            }
          } else {
            logger.warn(
              { orgId, fpUserId: job.assignedFpUserId, fpJobId: job.fpId },
              "FP job import: assignment user not found in FP roster — left unassigned",
            );
          }
        }
      }

      // Multi-tech: serviceRequests.assignedTo is single — keep first assignment
      // as assignedTo (above); for jobs with >1 assignment, append a line to the
      // description so the scheduler can see the additional techs. Resolve names
      // via the once-per-run FP roster cache.
      let finalDescription = job.description;
      if (job.additionalFpUserIds.length > 0) {
        counts.multiTechJobs = (counts.multiTechJobs ?? 0) + 1;
        const fpRoster = await resolveFpUserCache();
        const additionalNames = job.additionalFpUserIds.map((uid) => {
          const u = fpRoster.get(uid);
          return u?.name?.trim() || `FP user #${uid}`;
        });
        finalDescription = `${job.description}\nAlso assigned in FieldPulse: ${additionalNames.join(", ")}`;
      }

      const isNew = !existingFpIds.has(job.fpId);

      if (isNew) {
        // Synthetic session: service_requests.sessionId is NOT NULL (mirrors
        // membership-visit-queries.ts pattern for system-generated requests).
        const sessionId = randomUUID();
        const serviceRequestId = randomUUID();
        const referenceNumber = generateReferenceNumber();

        await db.batch([
          db.insert(customerSessions).values({
            id: sessionId,
            organizationId: orgId,
            token: `fp-import-${job.fpId}`,
            status: "submitted",
            channel: "web",
            customerId,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          db.insert(serviceRequests).values({
            id: serviceRequestId,
            organizationId: orgId,
            sessionId,
            customerId,
            assignedTo,
            status: job.status,
            issueType: job.issueType,
            urgency: "medium",
            description: finalDescription,
            scheduledDate: job.scheduledDate,
            arrivalWindowStart: job.arrivalWindowStart,
            arrivalWindowEnd: job.arrivalWindowEnd,
            completedAt: job.completedAt,
            referenceNumber,
            fieldpulseJobId: job.fpId,
            isAfterHours: false,
          }),
        ]);
        existingFpIds.add(job.fpId);
        counts.created++;
      } else {
        // Update: status, schedule, arrival window, tech assignment, description.
        // Never touch rows without fieldpulseJobId (native requests stay disjoint).
        await db
          .update(serviceRequests)
          .set({
            status: job.status,
            assignedTo,
            description: finalDescription,
            scheduledDate: job.scheduledDate,
            arrivalWindowStart: job.arrivalWindowStart,
            arrivalWindowEnd: job.arrivalWindowEnd,
            completedAt: job.completedAt,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(serviceRequests.organizationId, orgId),
              eq(serviceRequests.fieldpulseJobId, job.fpId),
            ),
          );
        counts.updated++;
      }
    } catch (err) {
      counts.errors++;
      logger.error(
        { orgId, fpJobId: job.fpId, error: err instanceof Error ? err.message : String(err) },
        "FP job import: per-record error (continuing)",
      );
    }
  }

  // Log unknown status int tally once per walk — not once per record.
  if (unknownTally.size > 0) {
    const summary = Object.fromEntries(unknownTally.entries());
    logger.warn(
      { orgId, unknownStatusInts: summary },
      "FP job import: unmapped status integers mapped to 'pending' — update FP_JOB_STATUS_MAP when names are confirmed",
    );
  }

  if (missingCustomerCount > 0) {
    logger.warn(
      { orgId, missingCustomerCount },
      "FP job import: skipped jobs whose FP customer_id had no native customer row — run Phase 3 first",
    );
  }
}
