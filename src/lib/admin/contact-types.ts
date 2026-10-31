import { z } from "zod";
import { sanitizeName, sanitizePhone, sanitizeEmail } from "@/lib/ai/sanitize-fields";
import { isPhoneComplete } from "@/lib/ai/extraction-schema";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const phoneField = z.string().max(40).transform((v) => sanitizePhone(v)).refine((v) => isPhoneComplete(v), "Phone must be a 10-digit US number.");
const emailField = z.string().max(254).transform((v) => sanitizeEmail(v)).refine((v) => z.email().safeParse(v).success, "Email address isn't valid.");
const roleField = z.string().max(60).transform((v) => v.trim());
const nameField = z.string().transform((v) => sanitizeName(v)).pipe(z.string().min(1, "Name is required.").max(200));

export const contactInputSchema = z.object({
  name: nameField,
  role: roleField.nullable().optional().transform((v) => (v ? v : null)),
  phone: phoneField.nullable().optional().transform((v) => v ?? null),
  email: emailField.nullable().optional().transform((v) => v ?? null),
  locationId: z.string().regex(UUID_REGEX).nullable().optional().transform((v) => v ?? null),
  isPrimary: z.boolean().optional(),
});
export type ContactInput = z.infer<typeof contactInputSchema>;

/** PATCH: omitted = unchanged (undefined), null = clear. No undefined→null transform. */
export const contactPatchSchema = z.object({
  name: nameField.optional(),
  role: roleField.nullable().optional(),
  phone: phoneField.nullable().optional(),
  email: emailField.nullable().optional(),
  locationId: z.string().regex(UUID_REGEX).nullable().optional(),
  isPrimary: z.boolean().optional(),
});
export type ContactPatch = z.infer<typeof contactPatchSchema>;

export interface ContactRecord {
  readonly id: string; readonly customerId: string; readonly locationId: string | null;
  readonly name: string; readonly role: string | null; readonly phone: string | null; readonly email: string | null;
  readonly isPrimary: boolean; readonly position: number;
}
