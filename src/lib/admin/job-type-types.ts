import { z } from "zod";
import { jobTypeValues, urgencyValues } from "@/lib/ai/extraction-schema";

export type JobTypeKind = (typeof jobTypeValues)[number];
export type JobTypePriority = (typeof urgencyValues)[number];

export interface JobTypeRecord {
  readonly id: string; readonly name: string; readonly kind: JobTypeKind;
  readonly defaultDurationMinutes: number; readonly defaultPriority: JobTypePriority;
  readonly active: boolean; readonly position: number;
}

export const jobTypeInputSchema = z.object({
  name: z.string().transform((v) => v.trim()).pipe(z.string().min(1, "Name is required.").max(80, "Name must be 80 characters or fewer.")),
  kind: z.enum(jobTypeValues),
  defaultDurationMinutes: z.number().int().min(15).max(1440),
  defaultPriority: z.enum(urgencyValues),
  active: z.boolean().optional(),
  position: z.number().int().min(0).max(999).optional(),
});
export type JobTypeInput = z.infer<typeof jobTypeInputSchema>;
export const jobTypePatchSchema = jobTypeInputSchema.partial();
export type JobTypePatch = z.infer<typeof jobTypePatchSchema>;

/** Same nine rows as drizzle/0047 seeds; durations from JOB_DURATION_DEFAULTS. */
export const DEFAULT_JOB_TYPES = [
  { name: "Service call", kind: "service_call", minutes: 90, priority: "medium" },
  { name: "No heat", kind: "no_heat", minutes: 105, priority: "high" },
  { name: "No cooling", kind: "no_cool", minutes: 105, priority: "high" },
  { name: "Maintenance", kind: "maintenance", minutes: 60, priority: "low" },
  { name: "Installation", kind: "install", minutes: 480, priority: "medium" },
  { name: "Estimate", kind: "estimate", minutes: 30, priority: "low" },
  { name: "Warranty", kind: "warranty", minutes: 90, priority: "medium" },
  { name: "Diagnostic", kind: "diagnostic", minutes: 75, priority: "medium" },
  { name: "Inspection", kind: "inspection", minutes: 45, priority: "low" },
] as const satisfies readonly { name: string; kind: JobTypeKind; minutes: number; priority: JobTypePriority }[];
