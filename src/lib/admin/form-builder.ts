/**
 * Pure helpers for the office form builder (M3d spec §7.1, §8). The builder
 * keeps strings for its inputs (usual range) and converts to a
 * FormDefinition only when it saves. Client-safe.
 */
import { FORM_LIMITS, FIELD_TYPES, utf8Bytes, type FieldType, type FormDefinition, type FormField } from "@/lib/forms/form-schema";
import { numberInputState } from "@/lib/forms/form-values";

export interface BuilderOption { readonly id: string; readonly label: string }

export interface BuilderField {
  readonly id: string;
  readonly type: FieldType;
  readonly label: string;
  readonly help: string;
  readonly required: boolean;
  readonly allowNa: boolean;
  readonly unit: string;
  readonly usualMin: string;
  readonly usualMax: string;
  readonly options: readonly BuilderOption[];
}

export interface BuilderForm {
  readonly name: string;
  readonly description: string;
  readonly appliesTo: "all" | "some";
  readonly jobTypeIds: readonly string[];
  readonly required: boolean;
  readonly fields: readonly BuilderField[];
}

export const TYPE_LABELS: Record<FieldType, string> = {
  checkbox: "Checkbox",
  yes_no: "Yes / no",
  short_text: "Short answer",
  long_text: "Long answer",
  number: "Number",
  choice: "Choice",
  heading: "Heading",
};
export const TYPE_ORDER: readonly FieldType[] = FIELD_TYPES;
export const UNIT_SUGGESTIONS = ["psi", "°F", "A", "V", "µF", "inWC", "microns", "CFM"] as const;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomTail(n: number, random: () => number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return out;
}
export const newFieldId = (random: () => number = Math.random): string => `f_${randomTail(10, random)}`;
export const newOptionId = (random: () => number = Math.random): string => `o_${randomTail(8, random)}`;

export function blankField(type: FieldType = "checkbox", random: () => number = Math.random): BuilderField {
  return {
    id: newFieldId(random), type, label: "", help: "", required: false, allowNa: false, unit: "", usualMin: "", usualMax: "",
    options: type === "choice" ? [{ id: newOptionId(random), label: "" }, { id: newOptionId(random), label: "" }] : [],
  };
}

/** `New form`: empty name, one blank Checkbox question. */
export function newBuilderForm(random: () => number = Math.random): BuilderForm {
  return { name: "", description: "", appliesTo: "all", jobTypeIds: [], required: false, fields: [blankField("checkbox", random)] };
}

/** Insert a blank question after index `at` (-1 = at the top; fields.length - 1 = at the end). */
export function addField(fields: readonly BuilderField[], at: number, random: () => number = Math.random): BuilderField[] {
  const i = Math.max(-1, Math.min(at, fields.length - 1)) + 1;
  return [...fields.slice(0, i), blankField("checkbox", random), ...fields.slice(i)];
}

export function moveField(fields: readonly BuilderField[], from: number, dir: -1 | 1): BuilderField[] {
  const to = from + dir;
  if (from < 0 || from >= fields.length || to < 0 || to >= fields.length) return [...fields];
  const out = [...fields];
  [out[from], out[to]] = [out[to]!, out[from]!];
  return out;
}

export function removeField(fields: readonly BuilderField[], at: number): { fields: BuilderField[]; removed: { field: BuilderField; at: number } | null } {
  if (at < 0 || at >= fields.length) return { fields: [...fields], removed: null };
  return { fields: fields.filter((_, i) => i !== at), removed: { field: fields[at]!, at } };
}

/** Undo puts the field back where it was (or at the end if the list got shorter). */
export function restoreField(fields: readonly BuilderField[], removed: { field: BuilderField; at: number }): BuilderField[] {
  const i = Math.min(removed.at, fields.length);
  return [...fields.slice(0, i), removed.field, ...fields.slice(i)];
}

/** Keeps label and help; keeps `required` except heading → false; drops every type extra; choice seeds two empty options. */
export function changeType(field: BuilderField, type: FieldType, random: () => number = Math.random): BuilderField {
  return {
    id: field.id, type, label: field.label, help: field.help,
    required: type === "heading" ? false : field.required,
    allowNa: false, unit: "", usualMin: "", usualMax: "",
    options: type === "choice" ? [{ id: newOptionId(random), label: "" }, { id: newOptionId(random), label: "" }] : [],
  };
}

const rangeValue = (raw: string): number | undefined => {
  const s = numberInputState(raw);
  return s.kind === "value" ? s.value : undefined;
};

export function toFormFields(fields: readonly BuilderField[]): FormField[] {
  return fields.map((f): FormField => {
    const base = { id: f.id, label: f.label.trim(), required: f.type === "heading" ? false : f.required, ...(f.help.trim() ? { help: f.help.trim() } : {}) };
    switch (f.type) {
      case "yes_no":
        return { ...base, type: "yes_no", ...(f.allowNa ? { allowNa: true } : {}) };
      case "number": {
        const lo = rangeValue(f.usualMin);
        const hi = rangeValue(f.usualMax);
        return { ...base, type: "number", ...(f.unit.trim() ? { unit: f.unit.trim() } : {}), ...(lo !== undefined ? { usualMin: lo } : {}), ...(hi !== undefined ? { usualMax: hi } : {}) };
      }
      case "choice":
        return { ...base, type: "choice", options: f.options.map((o) => ({ id: o.id, label: o.label.trim() })) };
      default:
        return { ...base, type: f.type };
    }
  });
}

export function toDefinition(form: BuilderForm): FormDefinition {
  return {
    name: form.name.trim(),
    description: form.description.trim() === "" ? null : form.description.trim(),
    jobTypeIds: form.appliesTo === "all" ? [] : [...form.jobTypeIds],
    required: form.required,
    fields: toFormFields(form.fields),
  };
}

/** The loaded row as builder state (archived job type ids are kept as they are). */
export function fromDefinition(d: {
  readonly name: string;
  readonly description: string | null;
  readonly jobTypeIds: readonly string[];
  readonly required: boolean;
  readonly fields: readonly FormField[];
}): BuilderForm {
  return {
    name: d.name,
    description: d.description ?? "",
    appliesTo: d.jobTypeIds.length === 0 ? "all" : "some",
    jobTypeIds: [...d.jobTypeIds],
    required: d.required,
    fields: d.fields.map((f) => ({
      id: f.id, type: f.type, label: f.label, help: f.help ?? "", required: f.required,
      allowNa: f.type === "yes_no" ? f.allowNa === true : false,
      unit: f.type === "number" ? f.unit ?? "" : "",
      usualMin: f.type === "number" && f.usualMin !== undefined ? String(f.usualMin) : "",
      usualMax: f.type === "number" && f.usualMax !== undefined ? String(f.usualMax) : "",
      options: f.type === "choice" ? f.options.map((o) => ({ id: o.id, label: o.label })) : [],
    })),
  };
}

export const sameDefinition = (a: FormDefinition, b: FormDefinition): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface BuilderError {
  /** "form" for header rules, else the field id the rule is about. */
  readonly target: "form" | string;
  readonly message: string;
}

export const BUILDER_COPY = {
  name: "Give the form a name.",
  nameLong: "Keep the name to 80 characters or fewer.",
  descriptionLong: "Keep the description to 300 characters or fewer.",
  noQuestion: "Add at least one question.",
  tooMany: "Up to 60 questions and headings.",
  longText: "Up to 10 long answers per form.",
  label: "Add a label.",
  labelLong: "Keep the label to 120 characters or fewer.",
  helpLong: "Keep the help to 200 characters or fewer.",
  unitLong: "Keep the unit to 12 characters or fewer.",
  fewOptions: "Add at least two options.",
  manyOptions: "Up to 12 options.",
  optionLabel: "Each option needs a label.",
  optionLong: "Keep each option to 60 characters or fewer.",
  optionDuplicate: "Two options have the same label.",
  range: "The low end can't be above the high end.",
  rangeNumber: "Enter a number like 12.5 (up to 3 decimal places).",
  jobTypes: "Pick at least one job type, or choose All requests.",
  size: "This form is too large. Remove some questions.",
} as const;

/** One message per broken rule (spec §8), in form order. */
export function builderErrors(form: BuilderForm): BuilderError[] {
  const out: BuilderError[] = [];
  const add = (target: string, message: string) => out.push({ target, message });
  const name = form.name.trim();
  if (name === "") add("form", BUILDER_COPY.name);
  if (name.length > FORM_LIMITS.name) add("form", BUILDER_COPY.nameLong);
  if (form.description.trim().length > FORM_LIMITS.description) add("form", BUILDER_COPY.descriptionLong);
  if (form.appliesTo === "some" && form.jobTypeIds.length === 0) add("form", BUILDER_COPY.jobTypes);
  if (!form.fields.some((f) => f.type !== "heading")) add("form", BUILDER_COPY.noQuestion);
  if (form.fields.length > FORM_LIMITS.maxFields) add("form", BUILDER_COPY.tooMany);
  if (form.fields.filter((f) => f.type === "long_text").length > FORM_LIMITS.maxLongText) add("form", BUILDER_COPY.longText);
  for (const f of form.fields) {
    const label = f.label.trim();
    if (label === "") add(f.id, BUILDER_COPY.label);
    if (label.length > FORM_LIMITS.label) add(f.id, BUILDER_COPY.labelLong);
    if (f.help.trim().length > FORM_LIMITS.help) add(f.id, BUILDER_COPY.helpLong);
    if (f.type === "number") {
      if (f.unit.trim().length > FORM_LIMITS.unit) add(f.id, BUILDER_COPY.unitLong);
      const lo = numberInputState(f.usualMin);
      const hi = numberInputState(f.usualMax);
      if ((lo.kind !== "empty" && lo.kind !== "value") || (hi.kind !== "empty" && hi.kind !== "value")) add(f.id, BUILDER_COPY.rangeNumber);
      else if (lo.kind === "value" && hi.kind === "value" && lo.value > hi.value) add(f.id, BUILDER_COPY.range);
    }
    if (f.type === "choice") {
      if (f.options.length < FORM_LIMITS.minOptions) add(f.id, BUILDER_COPY.fewOptions);
      if (f.options.length > FORM_LIMITS.maxOptions) add(f.id, BUILDER_COPY.manyOptions);
      const labels = f.options.map((o) => o.label.trim());
      if (labels.some((l) => l === "")) add(f.id, BUILDER_COPY.optionLabel);
      if (labels.some((l) => l.length > FORM_LIMITS.optionLabel)) add(f.id, BUILDER_COPY.optionLong);
      const filled = labels.filter((l) => l !== "").map((l) => l.toLowerCase());
      if (new Set(filled).size !== filled.length) add(f.id, BUILDER_COPY.optionDuplicate);
    }
  }
  if (utf8Bytes(JSON.stringify(toFormFields(form.fields))) > FORM_LIMITS.definitionBytes) add("form", BUILDER_COPY.size);
  return out;
}

/** Errors shown under "Fix these to save:": touched targets only, or all after a tap on the disabled Save. */
export function visibleErrors(errors: readonly BuilderError[], touched: ReadonlySet<string>, showAll: boolean): BuilderError[] {
  return showAll ? [...errors] : errors.filter((e) => touched.has(e.target));
}

export type FirstSaveOutcome =
  | { readonly kind: "created"; readonly id: string; readonly version: 1 }
  | { readonly kind: "replay"; readonly id: string }
  | { readonly kind: "unknown" }
  | { readonly kind: "refused"; readonly code: string };

/** The first Save's answer (spec §4.1). `status` null = no answer (network). */
export function firstSaveOutcome(status: number | null, body: unknown): FirstSaveOutcome {
  const env = (body ?? {}) as { data?: { id?: unknown }; error?: { code?: unknown } };
  const id = typeof env.data?.id === "string" ? env.data.id : null;
  if (status === 201 && id) return { kind: "created", id, version: 1 };
  if (status === 200 && id) return { kind: "replay", id };
  if (status === null || status >= 500 || status === 429 || ((status === 200 || status === 201) && !id)) return { kind: "unknown" };
  return { kind: "refused", code: typeof env.error?.code === "string" ? env.error.code : "UNKNOWN" };
}

/** After a 200 replay the builder GETs the row: it continues as an edit at the row's version, dirty when its own state differs. */
export function afterReplay(draft: FormDefinition, row: FormDefinition & { version: number }): { version: number; dirty: boolean } {
  const { version, ...rowDef } = row;
  return { version, dirty: !sameDefinition(draft, rowDef) };
}
