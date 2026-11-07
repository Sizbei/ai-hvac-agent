/** Request bodies for the technician form writes (M3d spec §4.2–§4.3). */
import { z } from "zod";
import { FORM_LIMITS } from "./form-schema";

const changeValue = z.union([z.literal(true), z.string(), z.number(), z.null()]);

/** `{ [fieldId]: value | null }`; the writer checks keys and values against the snapshot. */
export const changesSchema = z
  .record(z.string(), changeValue)
  .refine((c) => Object.keys(c).length <= FORM_LIMITS.maxFields);

export const submitBodySchema = z.object({
  appointmentId: z.string().uuid(),
  formVersion: z.number().int().min(1),
  baseRevision: z.number().int().min(0),
  changes: changesSchema,
}).strict();

export const draftBodySchema = submitBodySchema.extend({ saveId: z.string().uuid() }).strict();

export type SubmitBody = z.infer<typeof submitBodySchema>;
export type DraftBody = z.infer<typeof draftBodySchema>;
