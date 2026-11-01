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

interface Span {
  readonly startsAt: string;
  readonly endsAt: string;
}
const endAfterStart = (v: Span): boolean => Date.parse(v.endsAt) > Date.parse(v.startsAt);
const withinMaxShift = (v: Span): boolean => Date.parse(v.endsAt) - Date.parse(v.startsAt) <= MAX_SHIFT_MS;
const END_AFTER_START = { message: "End must be after start.", path: ["endsAt"] };
const WITHIN_MAX_SHIFT = { message: "A shift can be at most 31 days.", path: ["endsAt"] };

export const shiftInputSchema = z
  .object({
    kind: z.enum(shiftKindValues),
    title: z.string().trim().max(80).optional(),
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
    removesCapacity: z.boolean().optional(),
  })
  .refine(endAfterStart, END_AFTER_START)
  .refine(withinMaxShift, WITHIN_MAX_SHIFT)
  .transform((v) => ({
    ...v,
    removesCapacity: v.removesCapacity ?? defaultRemovesCapacity(v.kind),
  }));
export type ShiftInput = z.output<typeof shiftInputSchema>;

export const MAX_SHIFT_SPANS = 31;

const spanSchema = z
  .object({ startsAt: z.iso.datetime(), endsAt: z.iso.datetime() })
  .refine(endAfterStart, END_AFTER_START)
  .refine(withinMaxShift, WITHIN_MAX_SHIFT);

/** Several spans of one kind saved together (multi-day time off): all or nothing. */
export const shiftBatchInputSchema = z
  .object({
    kind: z.enum(shiftKindValues),
    title: z.string().trim().max(80).optional(),
    removesCapacity: z.boolean().optional(),
    spans: z.array(spanSchema).min(1).max(MAX_SHIFT_SPANS),
  })
  .transform((v) => ({
    ...v,
    removesCapacity: v.removesCapacity ?? defaultRemovesCapacity(v.kind),
  }));
export type ShiftBatchInput = z.output<typeof shiftBatchInputSchema>;

const SHIFT_KIND_LABEL: Record<ShiftKind, string> = {
  time_off: "Time off",
  on_call: "On call",
  non_job: "Non-job event",
};

/** Capacity-removing shifts as pseudo-jobs so the conflict/calendar logic treats them as busy time. */
export function blocksToScheduledJobs(rows: readonly ShiftRecord[]): readonly ScheduledJob[] {
  return rows.map((r) => ({
    id: r.id,
    referenceNumber: r.title ?? SHIFT_KIND_LABEL[r.kind],
    status: "assigned",
    assignedTo: r.technicianId,
    arrivalWindowStart: r.startsAt,
    arrivalWindowEnd: r.endsAt,
    timeOff: true,
  }));
}

/** Time off is never overridable: any time-off entry in a clash blocks "schedule anyway". */
export function hasTimeOff(conflicts: readonly ScheduledJob[]): boolean {
  return conflicts.some((c) => c.timeOff === true);
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
