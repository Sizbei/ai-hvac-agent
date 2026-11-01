import { and, asc, eq, gt, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { technicianShifts, users } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import type { ScheduledJob } from "./types";
import {
  blocksToScheduledJobs,
  type ShiftBatchInput,
  type ShiftInput,
  type ShiftRecord,
} from "./shift-types";

export function toShiftRecord(row: typeof technicianShifts.$inferSelect): ShiftRecord {
  return {
    id: row.id,
    technicianId: row.technicianId,
    kind: row.kind,
    title: row.title,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    removesCapacity: row.removesCapacity,
  };
}

/** Shifts overlapping [from, to), half-open. */
export async function listShifts(
  organizationId: string,
  technicianId: string,
  fromIso: string,
  toIso: string,
): Promise<readonly ShiftRecord[]> {
  const rows = await db
    .select()
    .from(technicianShifts)
    .where(
      withTenant(
        technicianShifts,
        organizationId,
        eq(technicianShifts.technicianId, technicianId),
        lt(technicianShifts.startsAt, new Date(toIso)),
        gt(technicianShifts.endsAt, new Date(fromIso)),
      ),
    )
    .orderBy(asc(technicianShifts.startsAt));
  return rows.map(toShiftRecord);
}

async function isActiveTechnician(organizationId: string, technicianId: string): Promise<boolean> {
  const [tech] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      withTenant(
        users,
        organizationId,
        and(eq(users.id, technicianId), eq(users.role, "technician"), eq(users.isActive, true))!,
      ),
    );
  return tech !== undefined;
}

export async function createShift(
  organizationId: string,
  technicianId: string,
  input: ShiftInput,
  createdBy: string,
): Promise<ShiftRecord | { readonly reason: "technician_not_found" }> {
  if (!(await isActiveTechnician(organizationId, technicianId))) {
    return { reason: "technician_not_found" };
  }

  const [row] = await db
    .insert(technicianShifts)
    .values({
      organizationId,
      technicianId,
      kind: input.kind,
      title: input.title || null,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      removesCapacity: input.removesCapacity,
      createdBy,
    })
    .returning();
  if (!row) throw new Error("Failed to create shift");
  return toShiftRecord(row);
}

/** Every span in ONE insert statement: all of them are saved or none. */
export async function createShifts(
  organizationId: string,
  technicianId: string,
  input: ShiftBatchInput,
  createdBy: string,
): Promise<readonly ShiftRecord[] | { readonly reason: "technician_not_found" }> {
  if (!(await isActiveTechnician(organizationId, technicianId))) {
    return { reason: "technician_not_found" };
  }
  const title = input.title || null;
  const rows = await db
    .insert(technicianShifts)
    .values(
      input.spans.map((span) => ({
        organizationId,
        technicianId,
        kind: input.kind,
        title,
        startsAt: new Date(span.startsAt),
        endsAt: new Date(span.endsAt),
        removesCapacity: input.removesCapacity,
        createdBy,
      })),
    )
    .returning();
  return rows.map(toShiftRecord);
}

export async function deleteShift(
  organizationId: string,
  technicianId: string,
  shiftId: string,
): Promise<boolean> {
  const rows = await db
    .delete(technicianShifts)
    .where(
      withTenant(
        technicianShifts,
        organizationId,
        eq(technicianShifts.id, shiftId),
        eq(technicianShifts.technicianId, technicianId),
      ),
    )
    .returning({ id: technicianShifts.id });
  return rows.length > 0;
}

/** Capacity-removing shifts overlapping [start, end), as pseudo-jobs. */
export async function listCapacityBlocks(
  organizationId: string,
  startIso: string,
  endIso: string,
): Promise<readonly ScheduledJob[]> {
  const rows = await db
    .select()
    .from(technicianShifts)
    .where(
      withTenant(
        technicianShifts,
        organizationId,
        eq(technicianShifts.removesCapacity, true),
        lt(technicianShifts.startsAt, new Date(endIso)),
        gt(technicianShifts.endsAt, new Date(startIso)),
      ),
    );
  return blocksToScheduledJobs(rows.map(toShiftRecord));
}

export async function technicianTimeOffOverlapping(
  organizationId: string,
  technicianId: string,
  start: Date,
  end: Date,
): Promise<readonly ShiftRecord[]> {
  const rows = await db
    .select()
    .from(technicianShifts)
    .where(
      withTenant(
        technicianShifts,
        organizationId,
        eq(technicianShifts.technicianId, technicianId),
        eq(technicianShifts.removesCapacity, true),
        lt(technicianShifts.startsAt, end),
        gt(technicianShifts.endsAt, start),
      ),
    )
    .orderBy(asc(technicianShifts.startsAt));
  return rows.map(toShiftRecord);
}

export async function getShift(
  organizationId: string,
  technicianId: string,
  shiftId: string,
): Promise<ShiftRecord | null> {
  const [row] = await db
    .select()
    .from(technicianShifts)
    .where(
      withTenant(
        technicianShifts,
        organizationId,
        eq(technicianShifts.id, shiftId),
        eq(technicianShifts.technicianId, technicianId),
      ),
    );
  return row ? toShiftRecord(row) : null;
}
