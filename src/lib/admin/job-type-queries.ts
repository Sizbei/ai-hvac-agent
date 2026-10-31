import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobTypes } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { isUniqueViolation } from "@/lib/db/unique-violation";
import { DEFAULT_JOB_TYPES, type JobTypeInput, type JobTypePatch, type JobTypeRecord } from "./job-type-types";

function toRecord(row: typeof jobTypes.$inferSelect): JobTypeRecord {
  return { id: row.id, name: row.name, kind: row.kind, defaultDurationMinutes: row.defaultDurationMinutes,
    defaultPriority: row.defaultPriority, active: row.active, position: row.position };
}

export async function listJobTypes(organizationId: string, opts: { readonly activeOnly?: boolean } = {}): Promise<readonly JobTypeRecord[]> {
  const rows = await db.select().from(jobTypes)
    .where(withTenant(jobTypes, organizationId, ...(opts.activeOnly ? [eq(jobTypes.active, true)] : [])))
    .orderBy(asc(jobTypes.position), asc(jobTypes.name));
  return rows.map(toRecord);
}

export async function createJobType(organizationId: string, input: JobTypeInput): Promise<JobTypeRecord | { readonly conflict: true }> {
  try {
    const [row] = await db.insert(jobTypes).values({
      organizationId, name: input.name, kind: input.kind, defaultDurationMinutes: input.defaultDurationMinutes,
      defaultPriority: input.defaultPriority, active: input.active ?? true, position: input.position ?? 0,
    }).returning();
    if (!row) throw new Error("Failed to create job type");
    return toRecord(row);
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

export async function updateJobType(organizationId: string, id: string, patch: JobTypePatch): Promise<JobTypeRecord | null | { readonly conflict: true }> {
  const set: Partial<typeof jobTypes.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.defaultDurationMinutes !== undefined) set.defaultDurationMinutes = patch.defaultDurationMinutes;
  if (patch.defaultPriority !== undefined) set.defaultPriority = patch.defaultPriority;
  if (patch.active !== undefined) set.active = patch.active;
  if (patch.position !== undefined) set.position = patch.position;
  try {
    const [row] = await db.update(jobTypes).set(set).where(withTenant(jobTypes, organizationId, eq(jobTypes.id, id))).returning();
    return row ? toRecord(row) : null;
  } catch (error: unknown) {
    if (isUniqueViolation(error)) return { conflict: true };
    throw error;
  }
}

/** One row per enum value; ON CONFLICT (org, name) DO NOTHING so re-runs are no-ops. */
export async function seedDefaultJobTypes(organizationId: string): Promise<void> {
  await db.insert(jobTypes).values(DEFAULT_JOB_TYPES.map((d, i) => ({
    organizationId, name: d.name, kind: d.kind, defaultDurationMinutes: d.minutes, defaultPriority: d.priority, position: i,
  }))).onConflictDoNothing({ target: [jobTypes.organizationId, jobTypes.name] });
}

/** Active, org-scoped lookup the create path uses to derive `job_type` and the duration. */
export async function resolveJobTypeForRequest(organizationId: string, jobTypeId: string): Promise<{ id: string; kind: JobTypeRecord["kind"]; defaultDurationMinutes: number } | null> {
  const [row] = await db.select({ id: jobTypes.id, kind: jobTypes.kind, defaultDurationMinutes: jobTypes.defaultDurationMinutes })
    .from(jobTypes).where(withTenant(jobTypes, organizationId, eq(jobTypes.id, jobTypeId), eq(jobTypes.active, true))).limit(1);
  return row ?? null;
}
