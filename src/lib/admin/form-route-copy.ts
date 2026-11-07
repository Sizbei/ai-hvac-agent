/** Office form route bodies and refusal copy (M3d spec §4.1, §5.6, §8). */
import { z } from "zod";
import { formDefinitionSchema } from "@/lib/forms/form-schema";

export const createFormBodySchema = formDefinitionSchema.extend({ clientToken: z.string().uuid() }).strict();

/** PATCH: a whole definition (fields replaced whole) or an archive / restore, always with the CAS version. */
export const patchFormBodySchema = z.object({
  version: z.number().int().min(1),
  definition: formDefinitionSchema.optional(),
  active: z.boolean().optional(),
}).strict().refine((b) => b.definition !== undefined || b.active !== undefined);

export const reopenBodySchema = z.object({ revision: z.number().int().min(0) }).strict();

export const FORM_OFFICE_COPY = {
  NAME_TAKEN: "A form with this name already exists.",
  STALE: "Someone else changed this form. Reload to see their changes.",
  LIMIT_REACHED: "You've reached the limit of 100 forms.",
  UNKNOWN_JOB_TYPE: "One of those job types no longer exists.",
  NOT_FOUND: "Form not found.",
  REOPEN_STALE: "Someone else changed this form. Reload to see the latest.",
  ANSWERS_REMOVED: "These answers were removed.",
} as const;
