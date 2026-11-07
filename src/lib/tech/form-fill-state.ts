/**
 * The fill page's answer bookkeeping (M3d spec §7.3): what each input holds,
 * which fields are touched, the `changes` body of the next PUT, what a landed
 * PUT does to `base` and `touched`, merges, and the submit checks. Pure.
 */
import type { FormField } from "@/lib/forms/form-schema";
import {
  applyChanges, carryValues, mergeDraft, missingRequired, numberInputState, stripControlChars,
  type Changes, type FieldValue, type FormValues,
} from "@/lib/forms/form-values";

/** checkbox: boolean; texts and numbers: the raw text; yes / no and choice: the picked value or null. */
export type InputValue = boolean | string | null;
export type Inputs = Readonly<Record<string, InputValue>>;
export type Parsed = { readonly kind: "value"; readonly value: FieldValue | null } | { readonly kind: "unparsed" };

export function inputsFromValues(fields: readonly FormField[], values: FormValues): Inputs {
  const out: Record<string, InputValue> = {};
  for (const f of fields) {
    const v = values[f.id];
    switch (f.type) {
      case "heading":
        break;
      case "checkbox":
        out[f.id] = v === true;
        break;
      case "number":
        out[f.id] = typeof v === "number" ? String(v) : "";
        break;
      case "short_text":
      case "long_text":
        out[f.id] = typeof v === "string" ? v : "";
        break;
      default:
        out[f.id] = typeof v === "string" ? v : null;
    }
  }
  return out;
}

/** What an input means right now; `null` value = empty (a cleared answer). */
export function parseInput(field: FormField, raw: InputValue | undefined): Parsed {
  switch (field.type) {
    case "heading":
      return { kind: "value", value: null };
    case "checkbox":
      return { kind: "value", value: raw === true ? true : null };
    case "yes_no":
    case "choice":
      return { kind: "value", value: typeof raw === "string" && raw !== "" ? raw : null };
    case "short_text":
    case "long_text": {
      const s = typeof raw === "string" ? stripControlChars(raw) : "";
      return { kind: "value", value: s === "" ? null : s };
    }
    case "number": {
      const st = numberInputState(typeof raw === "string" ? raw : "");
      if (st.kind === "empty") return { kind: "value", value: null };
      return st.kind === "value" ? { kind: "value", value: st.value } : { kind: "unparsed" };
    }
  }
}

/** Number fields remember their last valid value: a half-typed number never deletes the saved one. */
export function nextLastValid(lastValid: Readonly<Record<string, number>>, field: FormField, raw: InputValue): Record<string, number> {
  if (field.type !== "number") return { ...lastValid };
  const p = parseInput(field, raw);
  if (p.kind === "value" && typeof p.value === "number") return { ...lastValid, [field.id]: p.value };
  return { ...lastValid };
}

/** Numbers that aren't a value right now (partial, invalid or out of bounds). */
export function unparsedIds(fields: readonly FormField[], inputs: Inputs): string[] {
  return fields.filter((f) => f.type === "number" && parseInput(f, inputs[f.id]).kind === "unparsed").map((f) => f.id);
}

/**
 * The next PUT's `changes`: every touched field's parsed value, null when
 * emptied; an unparsed number sends its last valid value, or nothing if it
 * never had one.
 */
export function buildChanges(
  fields: readonly FormField[], inputs: Inputs, touched: ReadonlySet<string>, lastValid: Readonly<Record<string, number>>,
): Changes {
  const out: Record<string, FieldValue | null> = {};
  for (const f of fields) {
    if (f.type === "heading" || !touched.has(f.id)) continue;
    const p = parseInput(f, inputs[f.id]);
    if (p.kind === "value") out[f.id] = p.value;
    else if (f.id in lastValid) out[f.id] = lastValid[f.id]!;
  }
  return out;
}

/**
 * A PUT landed: `base` advances by that body, and a field leaves `touched`
 * only if what it holds now equals what the landed body sent (an edit made
 * during the flight stays touched and goes in the next PUT).
 */
export function afterLanded(
  fields: readonly FormField[], base: FormValues, landed: Changes, inputs: Inputs, touched: ReadonlySet<string>,
): { base: FormValues; touched: Set<string> } {
  const applied = applyChanges(fields, base, landed);
  const nextBase = applied.ok ? applied.values : base;
  const byId = new Map(fields.map((f) => [f.id, f]));
  const next = new Set(touched);
  for (const [id, sent] of Object.entries(landed)) {
    const f = byId.get(id);
    if (!f) continue;
    const now = parseInput(f, inputs[id]);
    if (now.kind === "value" && now.value === sent) next.delete(id);
  }
  return { base: nextBase, touched: next };
}

/** Merge a re-read row under my touched fields; untouched inputs follow the merged values. */
export function mergeIntoInputs(
  fields: readonly FormField[], base: FormValues, mine: Changes, theirs: FormValues, inputs: Inputs, touched: ReadonlySet<string>,
): { inputs: Inputs; base: FormValues; foreignChange: boolean } {
  const m = mergeDraft(base, mine, theirs);
  const fresh = inputsFromValues(fields, m.values);
  const out: Record<string, InputValue> = { ...fresh };
  for (const id of touched) if (id in inputs) out[id] = inputs[id]!;
  return { inputs: out, base: theirs, foreignChange: m.foreignChange };
}

/** FORM_CHANGED: carry base and mine to the new fields (spec §4.4); `dropped` = answers that no longer fit. */
export function carryForNewVersion(fields: readonly FormField[], base: FormValues, mine: Changes): { base: FormValues; mine: Changes; dropped: string[] } {
  const keptMine: Record<string, FieldValue | null> = {};
  const dropped: string[] = [];
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const [id, v] of Object.entries(mine)) {
    if (byId.has(id) && byId.get(id)!.type !== "heading" && (v === null || carryValues(fields, { [id]: v })[id] !== undefined)) keptMine[id] = v;
    else dropped.push(id);
  }
  return { base: carryValues(fields, base), mine: keptMine, dropped };
}

/** The full document the inputs describe (for submit). */
export function documentFromInputs(fields: readonly FormField[], inputs: Inputs, lastValid: Readonly<Record<string, number>>): FormValues {
  const out: Record<string, FieldValue> = {};
  for (const f of fields) {
    const p = parseInput(f, inputs[f.id]);
    if (p.kind === "value" && p.value !== null) out[f.id] = p.value;
    else if (p.kind === "unparsed" && f.id in lastValid) out[f.id] = lastValid[f.id]!;
  }
  return out;
}

export type SubmitBlock = { readonly kind: "unparsed"; readonly fieldIds: string[] } | { readonly kind: "missing"; readonly fieldIds: string[] } | null;

/** Submit is refused on the client while a number isn't a value, or required answers are missing. */
export function submitBlock(fields: readonly FormField[], inputs: Inputs): SubmitBlock {
  const unparsed = unparsedIds(fields, inputs);
  if (unparsed.length > 0) return { kind: "unparsed", fieldIds: unparsed };
  const missing = missingRequired(fields, documentFromInputs(fields, inputs, {}));
  return missing.length > 0 ? { kind: "missing", fieldIds: missing } : null;
}

/** `Clear answers`: every answered field sent as null. */
export function clearAllChanges(base: FormValues): Changes {
  return Object.fromEntries(Object.keys(base).map((id) => [id, null]));
}

/** `±` toggles a leading minus (the iOS decimal pad has none); empty becomes "-". */
export function toggleSign(raw: string): string {
  if (raw === "") return "-";
  return raw.startsWith("-") ? raw.slice(1) : `-${raw}`;
}
