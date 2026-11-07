/**
 * Answer values (M3d spec §3.3, §4.2, §4.4, §7.3): draft and submit validation,
 * the changes document, the 128 KB measure, the three-way merge, carry across
 * a form version, and the read-only answer text. Pure and client-safe.
 */
import { FORM_LIMITS, isFormNumber, utf8Bytes, type FormField } from "./form-schema";

export type FieldValue = true | string | number;
export type FormValues = Readonly<Record<string, FieldValue>>;
/** A draft PUT body's `changes`: every touched field, `null` = cleared. */
export type Changes = Readonly<Record<string, FieldValue | null>>;

const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const CONTROL_RE_G = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/** C0 controls other than tab, LF and CR. */
export const hasControlChars = (s: string): boolean => CONTROL_RE.test(s);
/** What the client does on input. */
export const stripControlChars = (s: string): string => s.replace(CONTROL_RE_G, "");

function textOk(v: unknown, max: number): boolean {
  return typeof v === "string" && v.length >= 1 && v.length <= max && !hasControlChars(v);
}

/** Type and parse only (no required, no range). `null` = cleared and is valid for any question. */
export function draftValueOk(field: FormField, value: unknown): boolean {
  if (field.type === "heading") return false;
  if (value === null) return true;
  switch (field.type) {
    case "checkbox":
      return value === true;
    case "yes_no":
      return value === "yes" || value === "no" || (value === "na" && field.allowNa === true);
    case "short_text":
      return textOk(value, FORM_LIMITS.shortText);
    case "long_text":
      return textOk(value, FORM_LIMITS.longText);
    case "number":
      return isFormNumber(value);
    case "choice":
      return typeof value === "string" && field.options.some((o) => o.id === value);
  }
}

export type ApplyResult = { ok: true; values: FormValues } | { ok: false; fieldIds: string[] };

/** Apply `changes` to `doc` against the snapshot `fields`; any bad key or value refuses the whole write. */
export function applyChanges(fields: readonly FormField[], doc: FormValues, changes: Changes): ApplyResult {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const bad = Object.entries(changes)
    .filter(([id, v]) => {
      const f = byId.get(id);
      return f === undefined || !draftValueOk(f, v);
    })
    .map(([id]) => id);
  if (bad.length > 0) return { ok: false, fieldIds: bad };
  const out: Record<string, FieldValue> = { ...doc };
  for (const [id, v] of Object.entries(changes)) {
    if (v === null) delete out[id];
    else out[id] = v;
  }
  return { ok: true, values: out };
}

/** UTF-8 bytes of JSON.stringify(values), measured the same on both sides. */
export const valuesBytes = (values: FormValues): number => utf8Bytes(JSON.stringify(values));
export const valuesTooLarge = (values: FormValues): boolean => valuesBytes(values) > FORM_LIMITS.valuesBytes;

export function isAnswered(field: FormField, value: FieldValue | undefined): boolean {
  if (field.type === "heading") return true;
  if (field.type === "checkbox") return value === true;
  return value !== undefined;
}

/** Required questions without an answer (`na` satisfies a yes / no). */
export function missingRequired(fields: readonly FormField[], values: FormValues): string[] {
  return fields.filter((f) => f.type !== "heading" && f.required && !isAnswered(f, values[f.id])).map((f) => f.id);
}

/** Keep only the answers that are still valid against `fields` (a new form version). */
export function carryValues(fields: readonly FormField[], values: FormValues): FormValues {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return Object.fromEntries(Object.entries(values).filter(([id, v]) => {
    const f = byId.get(id);
    return f !== undefined && draftValueOk(f, v);
  }));
}

/** Answers the carry dropped, for "Not saved: …". */
export function droppedByCarry(before: FormValues, after: FormValues): string[] {
  return Object.keys(before).filter((id) => !(id in after));
}

/**
 * Three-way merge (spec §7.3): touched fields (`mine`) win, every other field
 * takes `theirs`. `foreignChange` = a field not touched here differs between
 * `base` and `theirs` (someone else changed it).
 */
export function mergeDraft(base: FormValues, mine: Changes, theirs: FormValues): { values: FormValues; foreignChange: boolean } {
  const out: Record<string, FieldValue> = { ...theirs };
  for (const [id, v] of Object.entries(mine)) {
    if (v === null) delete out[id];
    else out[id] = v;
  }
  const keys = new Set([...Object.keys(base), ...Object.keys(theirs)]);
  const foreignChange = [...keys].some((k) => !(k in mine) && base[k] !== theirs[k]);
  return { values: out, foreignChange };
}

export type NumberInputState =
  | { readonly kind: "empty" }
  | { readonly kind: "partial" }
  | { readonly kind: "invalid" }
  | { readonly kind: "out_of_bounds" }
  | { readonly kind: "value"; readonly value: number };

const THOUSANDS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const PARTIAL_DECIMAL = /^-?\d*\.$/;
const PARTIAL_THOUSANDS = /^-?\d{1,3}(,\d{3})*,\d{0,2}$/;
const PLAIN = /^-?(\d+(\.\d*)?|\.\d+)$/;

/** What a number input holds right now (spec §3.3). */
export function numberInputState(raw: string): NumberInputState {
  const s = raw.trim();
  if (s === "") return { kind: "empty" };
  if (s === "-" || PARTIAL_DECIMAL.test(s) || PARTIAL_THOUSANDS.test(s)) return { kind: "partial" };
  const plain = THOUSANDS.test(s) ? s.replace(/,/g, "") : s;
  if (!PLAIN.test(plain)) return { kind: "invalid" };
  const decimals = plain.includes(".") ? plain.split(".")[1]!.length : 0;
  if (decimals > 3) return { kind: "invalid" };
  const n = Number(plain);
  if (!Number.isFinite(n)) return { kind: "invalid" };
  if (Math.abs(n) >= FORM_LIMITS.numberBound) return { kind: "out_of_bounds" };
  return { kind: "value", value: n === 0 ? 0 : n };
}

const fmt = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 3 });
const withUnit = (n: number, unit: string | undefined): string => (unit ? `${fmt(n)} ${unit}` : fmt(n));

/** "Outside the usual range (5–15 °F)" / "(at least 5 °F)" / "(at most 15 °F)"; null when inside or unset. */
export function rangeNote(field: FormField, value: unknown): string | null {
  if (field.type !== "number" || typeof value !== "number") return null;
  const { usualMin: lo, usualMax: hi, unit } = field;
  if (lo === undefined && hi === undefined) return null;
  const below = lo !== undefined && value < lo;
  const above = hi !== undefined && value > hi;
  if (!below && !above) return null;
  const suffix = unit ? ` ${unit}` : "";
  if (lo !== undefined && hi !== undefined) return `Outside the usual range (${fmt(lo)}–${fmt(hi)}${suffix})`;
  if (lo !== undefined) return `Outside the usual range (at least ${fmt(lo)}${suffix})`;
  return `Outside the usual range (at most ${fmt(hi!)}${suffix})`;
}

/** One answer as read-only text (office section, read-only fill page, "Not saved" list). */
export function answerText(field: FormField, value: FieldValue | undefined): string {
  switch (field.type) {
    case "heading":
      return field.label;
    case "checkbox":
      return value === true ? "Done" : "Not done";
    case "yes_no":
      return value === "yes" ? "Yes" : value === "no" ? "No" : value === "na" ? "N/A" : "No answer";
    case "choice":
      return field.options.find((o) => o.id === value)?.label ?? "No answer";
    case "number": {
      if (typeof value !== "number") return "No answer";
      const note = rangeNote(field, value);
      return note ? `${withUnit(value, field.unit)} · ${note}` : withUnit(value, field.unit);
    }
    case "short_text":
    case "long_text":
      return typeof value === "string" ? value : "No answer";
  }
}
