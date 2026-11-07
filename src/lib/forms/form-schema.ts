/**
 * Form definitions (M3d spec §3.3): a flat list of fields, validated by zod.
 * Pure and client-safe: shared by the server writers, the office builder and
 * the technician fill page. Error details are paths only, never zod messages.
 */
import { z } from "zod";

export const FIELD_TYPES = ["checkbox", "yes_no", "short_text", "long_text", "number", "choice", "heading"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_ID_RE = /^f_[a-z0-9]{10}$/;
export const OPTION_ID_RE = /^o_[a-z0-9]{8}$/;

export const FORM_LIMITS = {
  name: 80,
  description: 300,
  label: 120,
  help: 200,
  unit: 12,
  optionLabel: 60,
  minOptions: 2,
  maxOptions: 12,
  maxFields: 60,
  maxLongText: 10,
  definitionBytes: 64 * 1024,
  shortText: 200,
  longText: 2000,
  numberBound: 1_000_000,
  valuesBytes: 128 * 1024,
  maxForms: 100,
} as const;

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
}

interface FieldBase {
  readonly id: string;
  readonly label: string;
  readonly help?: string;
  readonly required: boolean;
}

export type FormField =
  | (FieldBase & { readonly type: "checkbox" })
  | (FieldBase & { readonly type: "yes_no"; readonly allowNa?: boolean })
  | (FieldBase & { readonly type: "short_text" })
  | (FieldBase & { readonly type: "long_text" })
  | (FieldBase & { readonly type: "number"; readonly unit?: string; readonly usualMin?: number; readonly usualMax?: number })
  | (FieldBase & { readonly type: "choice"; readonly options: readonly ChoiceOption[] })
  | (FieldBase & { readonly type: "heading" });

/** UTF-8 byte length (the caps are measured in bytes, not UTF-16 units). */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Finite, |x| < 1,000,000, at most 3 decimal places. */
export function isFormNumber(x: unknown): x is number {
  if (typeof x !== "number" || !Number.isFinite(x)) return false;
  if (Math.abs(x) >= FORM_LIMITS.numberBound) return false;
  return /^-?\d+(\.\d{1,3})?$/.test(String(x));
}

const label = z.string().trim().min(1).max(FORM_LIMITS.label);
const help = z.string().trim().max(FORM_LIMITS.help).optional();
const base = { id: z.string().regex(FIELD_ID_RE), label, help, required: z.boolean() };
const formNumber = z.number().refine(isFormNumber);

const fieldSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("checkbox") }).strict(),
  z.object({ ...base, type: z.literal("yes_no"), allowNa: z.boolean().optional() }).strict(),
  z.object({ ...base, type: z.literal("short_text") }).strict(),
  z.object({ ...base, type: z.literal("long_text") }).strict(),
  z.object({
    ...base,
    type: z.literal("number"),
    unit: z.string().trim().min(1).max(FORM_LIMITS.unit).optional(),
    usualMin: formNumber.optional(),
    usualMax: formNumber.optional(),
  }).strict(),
  z.object({
    ...base,
    type: z.literal("choice"),
    options: z
      .array(z.object({ id: z.string().regex(OPTION_ID_RE), label: z.string().trim().min(1).max(FORM_LIMITS.optionLabel) }).strict())
      .min(FORM_LIMITS.minOptions)
      .max(FORM_LIMITS.maxOptions),
  }).strict(),
  z.object({ ...base, type: z.literal("heading") }).strict(),
]);

/** The cross-field rules zod's per-field schemas can't see. */
export const formFieldsSchema = z.array(fieldSchema).max(FORM_LIMITS.maxFields).superRefine((fields, ctx) => {
  if (fields.length < 1 || fields.length > FORM_LIMITS.maxFields) ctx.addIssue({ code: "custom", path: [], message: "count" });
  if (!fields.some((f) => f.type !== "heading")) ctx.addIssue({ code: "custom", path: [], message: "no_question" });
  if (fields.filter((f) => f.type === "long_text").length > FORM_LIMITS.maxLongText) {
    ctx.addIssue({ code: "custom", path: [], message: "long_text" });
  }
  const ids = new Set<string>();
  fields.forEach((f, i) => {
    if (ids.has(f.id)) ctx.addIssue({ code: "custom", path: [i, "id"], message: "duplicate_id" });
    ids.add(f.id);
    if (f.type === "heading" && f.required) ctx.addIssue({ code: "custom", path: [i, "required"], message: "heading_required" });
    if (f.type === "choice") {
      const optionIds = new Set(f.options.map((o) => o.id));
      const labels = new Set(f.options.map((o) => o.label.toLowerCase()));
      if (optionIds.size !== f.options.length || labels.size !== f.options.length) {
        ctx.addIssue({ code: "custom", path: [i, "options"], message: "duplicate_option" });
      }
    }
    if (f.type === "number" && f.usualMin !== undefined && f.usualMax !== undefined && f.usualMin > f.usualMax) {
      ctx.addIssue({ code: "custom", path: [i, "usualMax"], message: "range" });
    }
  });
  if (utf8Bytes(JSON.stringify(fields)) > FORM_LIMITS.definitionBytes) ctx.addIssue({ code: "custom", path: [], message: "size" });
});

export const formDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(FORM_LIMITS.name),
  description: z.string().trim().max(FORM_LIMITS.description).nullable(),
  jobTypeIds: z.array(z.string().uuid()).max(100),
  required: z.boolean(),
  fields: formFieldsSchema,
}).strict();

/** What a saved form holds (the parsed body is assignable to it). */
export interface FormDefinition {
  readonly name: string;
  readonly description: string | null;
  readonly jobTypeIds: readonly string[];
  readonly required: boolean;
  readonly fields: readonly FormField[];
}

/** First issue's path for a 400 `{ path }` detail (never the zod message). */
export function firstIssuePath(error: z.ZodError): (string | number)[] {
  const path = error.issues[0]?.path ?? [];
  return path.filter((p): p is string | number => typeof p === "string" || typeof p === "number");
}

/** Parse stored jsonb back into fields; anything malformed yields null (render nothing, never throw). */
export function parseStoredFields(raw: unknown): readonly FormField[] | null {
  const r = z.array(fieldSchema).safeParse(raw);
  return r.success ? (r.data as readonly FormField[]) : null;
}

export const questionCount = (fields: readonly FormField[]): number => fields.filter((f) => f.type !== "heading").length;
