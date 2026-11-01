import { z } from "zod";
import type { ScheduledJob } from "./types";

export const shiftKindValues = ["on_call", "time_off", "non_job"] as const;
export type ShiftKind = (typeof shiftKindValues)[number];

export interface ShiftRecord {
  readonly id: string;
  readonly technicianId: string;
  readonly kind: ShiftKind;
  readonly title: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly removesCapacity: boolean;
}

const MAX_SHIFT_MS = 31 * 24 * 60 * 60 * 1000;

/** On-call is availability, so it keeps capacity; time off and non-job events remove it. */
export function defaultRemovesCapacity(kind: ShiftKind): boolean {
  return kind !== "on_call";
}

export const shiftInputSchema = z
  .object({
    kind: z.enum(shiftKindValues),
    title: z.string().trim().max(80).optional(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    removesCapacity: z.boolean().optional(),
  })
  .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
    message: "End must be after start.",
    path: ["endsAt"],
  })
  .refine((v) => Date.parse(v.endsAt) - Date.parse(v.startsAt) <= MAX_SHIFT_MS, {
    message: "A shift can be at most 31 days.",
    path: ["endsAt"],
  })
  .transform((v) => ({
    ...v,
    removesCapacity: v.removesCapacity ?? defaultRemovesCapacity(v.kind),
  }));
export type ShiftInput = z.output<typeof shiftInputSchema>;

/** Capacity-removing shifts as pseudo-jobs so the conflict/calendar logic treats them as busy time. */
export function blocksToScheduledJobs(rows: readonly ShiftRecord[]): readonly ScheduledJob[] {
  return rows.map((r) => ({
    id: r.id,
    referenceNumber: r.title ?? "Time off",
    status: "assigned",
    assignedTo: r.technicianId,
    arrivalWindowStart: r.startsAt,
    arrivalWindowEnd: r.endsAt,
  }));
}

export function excludeTechniciansWithBlocks(
  techIds: readonly string[],
  blocks: readonly ScheduledJob[],
): readonly string[] {
  const blocked = new Set(blocks.map((b) => b.assignedTo));
  return techIds.filter((id) => !blocked.has(id));
}

/** Blocks that cover the whole [start, end) span (not merely overlap it). */
export function blocksCoveringSpan(
  blocks: readonly ScheduledJob[],
  start: Date,
  end: Date,
): readonly ScheduledJob[] {
  return blocks.filter(
    (b) =>
      b.arrivalWindowStart !== null &&
      b.arrivalWindowEnd !== null &&
      Date.parse(b.arrivalWindowStart) <= start.getTime() &&
      Date.parse(b.arrivalWindowEnd) >= end.getTime(),
  );
}
