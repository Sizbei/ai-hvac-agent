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
  lastValid: Readonly<Record<string, number>>,
): { inputs: Inputs; base: FormValues; foreignChange: boolean; lastValid: Record<string, number> } {
  const m = mergeDraft(base, mine, theirs);
  const fresh = inputsFromValues(fields, m.values);
  const out: Record<string, InputValue> = { ...fresh };
  for (const id of touched) if (id in inputs) out[id] = inputs[id]!;
  // Untouched numbers follow the merged value, so a half-typed edit never sends a stale last-valid.
  const nextValid: Record<string, number> = { ...lastValid };
  for (const fl of fields) {
    if (fl.type !== "number" || touched.has(fl.id)) continue;
    const v = m.values[fl.id];
    if (typeof v === "number") nextValid[fl.id] = v;
    else delete nextValid[fl.id];
  }
  return { inputs: out, base: theirs, foreignChange: m.foreignChange, lastValid: nextValid };
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

/** What the page holds when a re-read merges in (the refs reconcile reads). */
export interface FillSnapshot {
  readonly fields: readonly FormField[];
  readonly version: number;
  /** The base `mine` was made against (a recovered submit brings its own). */
  readonly base: FormValues;
  readonly inputs: Inputs;
  readonly touched: ReadonlySet<string>;
  readonly lastValid: Readonly<Record<string, number>>;
}

/** The re-read row, as far as the merge needs it. */
export interface ReadRow {
  readonly form: { readonly version: number; readonly fields: readonly FormField[] };
  readonly submission: { readonly revision: number; readonly values: FormValues | null } | null;
}

export interface ReconcileResult {
  readonly fields: readonly FormField[];
  readonly version: number;
  /** `theirs`: the next PUT is based on the re-read row. */
  readonly base: FormValues;
  readonly revision: number;
  readonly touched: Set<string>;
  readonly inputs: Inputs;
  readonly lastValid: Record<string, number>;
  /** Answers the new version can't take (listed under "Not saved"). */
  readonly dropped: readonly string[];
  readonly formChanged: boolean;
  readonly foreignChange: boolean;
}

export const nonNull = (c: Changes): FormValues =>
  Object.fromEntries(Object.entries(c).filter((e): e is [string, FieldValue] => e[1] !== null));

/**
 * A re-read draft row merged into the page (STALE / FORM_CHANGED / a merged
 * leave save). `recovered` = `mine` is a recovered submit's changes (not in the
 * inputs yet): its inputs are rebuilt from them and only they are touched. A
 * live merge keeps every touched input (a half-typed number isn't in `mine`).
 * Untouched numbers reseed their last valid value from the merged row.
 */
export function reconcileTransition(s: FillSnapshot, mine: Changes, recovered: boolean, row: ReadRow, code: string | null): ReconcileResult {
  const formChanged = code === "FORM_CHANGED" || row.form.version !== s.version;
  let fields = s.fields;
  let base = s.base;
  let carriedMine = mine;
  let dropped: readonly string[] = [];
  if (formChanged) {
    fields = row.form.fields;
    const carried = carryForNewVersion(fields, s.base, mine);
    base = carried.base;
    carriedMine = carried.mine;
    dropped = carried.dropped;
  }
  const theirs = row.submission?.values ?? {};
  const mineInputs = recovered ? inputsFromValues(fields, nonNull(carriedMine)) : s.inputs;
  const ids = new Set(fields.map((f) => f.id));
  // A field the new version can't take leaves the touched set: its input follows the merged value and is never sent.
  const droppedIds = new Set(dropped);
  const touched = recovered
    ? new Set(Object.keys(carriedMine))
    : new Set([...s.touched, ...Object.keys(carriedMine)].filter((id) => ids.has(id) && !droppedIds.has(id)));
  const merged = mergeIntoInputs(fields, base, carriedMine, theirs, mineInputs, touched, s.lastValid);
  return {
    fields, version: row.form.version, base: theirs, revision: row.submission?.revision ?? 0, touched,
    inputs: merged.inputs, lastValid: merged.lastValid, dropped, formChanged, foreignChange: merged.foreignChange,
  };
}

/** A leave-time save (R1): for each changed field, the value this page last saw (null = absent). */
export function leaveBases(changes: Changes, base: FormValues): Record<string, FieldValue | null> {
  return Object.fromEntries(Object.keys(changes).map((id) => [id, Object.hasOwn(base, id) ? base[id]! : null]));
}

/**
 * A leave save answered 200: did the server merge it over a newer row (some
 * fields skipped, or the revision moved by more than this write)? Then the
 * page, if still open, re-reads; only the applied changes count as landed.
 */
export function leaveOutcome(sent: Changes, baseRevision: number, revision: number, skipped: unknown): { merged: boolean; applied: Changes } {
  const skip = new Set(Array.isArray(skipped) ? skipped.filter((x): x is string => typeof x === "string") : []);
  const applied = Object.fromEntries(Object.entries(sent).filter(([id]) => !skip.has(id)));
  return { merged: skip.size > 0 || revision !== baseRevision + 1, applied };
}

/** Erased or unreadable answers: the read-only view shows no field values at all (never "Not done"). */
export function answersHidden(submission: { readonly erased: boolean; readonly values: FormValues | null } | null): boolean {
  return submission !== null && (submission.erased || submission.values === null);
}

/** How long after a leave save the next load still reads again for it. */
export const LEAVE_MARK_MS = 30_000;

/**
 * A leave mark still waits for its save when it's recent and the loaded row
 * doesn't hold every change it sent yet (null = absent). A revision can't tell:
 * a colleague's save moves it too. A field the server skipped never matches,
 * so the wait ends at the caller's time limit.
 */
export function leaveMarkPending(raw: string | null, now: number, values: FormValues): boolean {
  if (!raw) return false;
  try {
    const m = JSON.parse(raw) as { at?: unknown; changes?: unknown };
    if (typeof m.at !== "number" || m.changes === null || typeof m.changes !== "object" || Array.isArray(m.changes)) return false;
    if (now - m.at < 0 || now - m.at >= LEAVE_MARK_MS) return false;
    return Object.keys(unsavedChanges(m.changes as Changes, values)).length > 0;
  } catch {
    return false;
  }
}

/**
 * The changes that would still move the row: `changes` minus what `base`
 * already holds (null = absent). A half-typed "12." whose 12 landed has
 * nothing left, so leaving doesn't wait on it.
 */
export function unsavedChanges(changes: Changes, base: FormValues): Changes {
  return Object.fromEntries(Object.entries(changes).filter(([id, v]) => (Object.hasOwn(base, id) ? base[id]! : null) !== v));
}
