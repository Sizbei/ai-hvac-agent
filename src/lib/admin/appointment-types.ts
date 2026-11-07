import { z } from "zod";

// Client-safe types for visits (appointments). Visit #1 mirrors the request;
// #2+ are added/edited through the appointments API.

export interface AppointmentAssignmentRecord {
  readonly technicianId: string;
  readonly technicianName: string;
  readonly isLead: boolean;
  readonly status: string;
  /** M2 §3.3: started by the board's rule (rowStarted). Set by listAppointments / getAppointment. */
  readonly started?: boolean;
  /** Any progress timestamp on the row. */
  readonly hasProgress?: boolean;
}

export interface AppointmentRecord {
  readonly id: string;
  readonly serviceRequestId: string;
  readonly appointmentNumber: number;
  readonly scheduledDate: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly arrivalWindowStart: string | null;
  readonly arrivalWindowEnd: string | null;
  readonly isConfirmed: boolean;
  readonly cancelledAt: string | null;
  readonly specialInstructions: string | null;
  readonly version: number;
  readonly assignments: readonly AppointmentAssignmentRecord[];
}

/** Most technicians one visit can carry. */
export const MAX_TECHNICIANS_PER_VISIT = 5;

/** True when both are dates and the end is strictly after the start. */
export function windowIsValid(start: string, end: string): boolean {
  const s = Date.parse(start);
  const e = Date.parse(end);
  return Number.isFinite(s) && Number.isFinite(e) && e > s;
}

/** Next visit number for a request: max + 1, never below 2 (#1 is the request's own). */
export function nextAppointmentNumber(existing: readonly { appointmentNumber: number }[]): number {
  const max = existing.reduce((m, a) => Math.max(m, a.appointmentNumber), 1);
  return max + 1;
}

const baseShape = {
  arrivalWindowStart: z.iso.datetime({ offset: true }),
  arrivalWindowEnd: z.iso.datetime({ offset: true }),
  technicianIds: z
    .array(z.uuid())
    .min(1, "Pick at least one technician.")
    .max(MAX_TECHNICIANS_PER_VISIT, `A visit can have at most ${MAX_TECHNICIANS_PER_VISIT} technicians.`),
  specialInstructions: z.string().max(1000, "Instructions must be 1000 characters or fewer.").optional(),
};

const windowRule = (v: { arrivalWindowStart: string; arrivalWindowEnd: string }) =>
  windowIsValid(v.arrivalWindowStart, v.arrivalWindowEnd);
const windowMessage = { message: "The window must end after it starts.", path: ["arrivalWindowEnd"] };

export const appointmentInputSchema = z.object(baseShape).refine(windowRule, windowMessage);
export type AppointmentInput = z.infer<typeof appointmentInputSchema>;

export const appointmentPatchSchema = z
  .object({ ...baseShape, version: z.number().int().min(0) })
  .refine(windowRule, windowMessage);
export type AppointmentPatch = z.infer<typeof appointmentPatchSchema>;

export const appointmentCancelSchema = z.object({ version: z.number().int().min(0) });
